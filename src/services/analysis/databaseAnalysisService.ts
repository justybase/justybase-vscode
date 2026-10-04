import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';
import { NZ_QUERIES } from '../../dialects/netezza/metadata/systemQueries';
import { buildNetezzaColumnsWithKeysQueries, mergeNetezzaColumnsWithKeysRows } from '../../dialects/netezza/metadata/columnsWithKeys';
import { wrapProcedureStringBody } from '../../sqlParser/procedure/procedureStringBody';
import { normalizeForeignKeyRelationshipRows } from '../../metadata/foreignKeyRelationships';
import { buildColumnCacheKey, mapRawColumnRowToMetadata } from '../../metadata/columnRowMapping';
import type { DefinitionCatalogSnapshot } from '../../metadata/definitionCatalog';
import { DependencyIndex, type DependencyEdge, type DependencyReport } from './dependencyIndex';
import { analyzeSql, objectId, type ObjectReference } from './sqlAnalysis';
import { type PerformanceTable, type PerformanceReport } from './performanceAdvisor';
import { analyzeExplainPlanSemantic, type ExplainPlanSemanticAnalysis } from '../tuning/explainPlanSemanticAnalyzer';
import { NetezzaTuningAdvisor } from '../../dialects/netezza/tuning/netezzaTuningAdvisor';
import { AnalysisSession } from './analysisSession';

const MAX_OBJECTS = 20_000;
function text(row: Record<string, unknown>, key: string): string { return String(row[key] ?? '').trimEnd(); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
interface IndexEntry { index: DependencyIndex; snapshot?: DefinitionCatalogSnapshot; connection: string }
/** Activation-owned services. MetadataCache owns definitions; only derived indexes live here. */
export class DatabaseAnalysisService implements vscode.Disposable {
    private indexes = new Map<string, IndexEntry>();
    private listeners: vscode.Disposable[];
    private generation = 0;
    private active = new Set<vscode.CancellationTokenSource>();
    private disposed = false;
    constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConnectionManager, private readonly cache: MetadataCache) {
        const invalidate = (connection?: string) => {
            this.generation++;
            cache.clearDefinitionCatalogs(connection);
            for (const [key, entry] of this.indexes) {
                if (!connection || entry.connection === connection) { entry.index.invalidate(); this.indexes.delete(key); }
            }
        };
        this.listeners = [cache.onDidInvalidate(invalidate), cache.onDidExternalRefresh(invalidate),
            cache.onDidPrefetchRefreshDetails(details => { if (details.completedAt) { invalidate(details.connectionName); } })];
    }
    dispose(): void {
        this.disposed = true;
        for (const source of this.active) { source.cancel(); source.dispose(); }
        this.active.clear();
        this.listeners.forEach(listener => listener.dispose());
        this.indexes.forEach(entry => entry.index.invalidate()); this.indexes.clear();
        this.cache.clearDefinitionCatalogs();
    }
    private async withSession<T>(connection: string, database: string, token: vscode.CancellationToken, action: (session: AnalysisSession, token: vscode.CancellationToken) => Promise<T>): Promise<T> {
        if (this.disposed) { throw new vscode.CancellationError(); }
        const source = new vscode.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => source.cancel());
        if (token.isCancellationRequested) { source.cancel(); }
        this.active.add(source);
        const session = new AnalysisSession(this.context, this.manager, connection, database, source.token);
        try { await session.open(); return await action(session, source.token); }
        finally { await session.close(); listener.dispose(); source.dispose(); this.active.delete(source); }
    }
    async dependencies(connection: string, root: ObjectReference, direction: 'incoming' | 'outgoing', depth: number, token: vscode.CancellationToken, column?: string): Promise<DependencyReport> {
        const generation = this.generation;
        let snapshot = this.cache.getDefinitionCatalog(connection, root.database);
        if (!snapshot) {
            snapshot = await this.withSession(connection, root.database, token, (session, activeToken) => this.loadCatalog(session, activeToken));
            if (generation !== this.generation || token.isCancellationRequested || this.disposed) { throw new vscode.CancellationError(); }
            this.cache.setDefinitionCatalog(connection, root.database, snapshot);
        }
        const key = JSON.stringify([connection, root.database]);
        const entry = this.indexes.get(key) ?? { index: new DependencyIndex(), connection };
        if (!this.indexes.has(key) && this.indexes.size >= 4) { const oldest = this.indexes.keys().next().value!; this.indexes.get(oldest)?.index.invalidate(); this.indexes.delete(oldest); }
        this.indexes.set(key, entry);
        if (entry.snapshot !== snapshot) {
            const slice = this.cache.getForeignKeyRelationshipsForDatabase(connection, root.database);
            const edges: DependencyEdge[] = (slice?.references ?? []).map(fk => ({
                source: { database: fk.fromDatabase ?? root.database, schema: fk.fromSchema, name: fk.fromTable, type: 'TABLE' },
                target: { database: fk.toDatabase ?? root.database, schema: fk.toSchema, name: fk.toTable, type: 'TABLE' },
                kind: 'column', column: fk.toColumn, confidence: slice?.complete ? 'exact' : 'probable', location: { start: 0, end: 0 }
            }));
            if (!await entry.index.update(snapshot.definitions, snapshot.objects, () => token.isCancellationRequested || this.disposed || generation !== this.generation, edges)) { throw new vscode.CancellationError(); }
            entry.snapshot = snapshot;
        }
        const report = entry.index.getReport(root, direction, depth, column);
        report.issues.push(...snapshot.issues, `Catalog scope: ${root.database}. Incoming references from other databases are not included.`, 'Sequences, function calls and complex column lineage are not resolved.');
        if (!this.cache.getForeignKeyRelationshipsForDatabase(connection, root.database)?.complete) { report.issues.push('Foreign-key catalog snapshot is incomplete or unavailable.'); }
        return report;
    }
    private async loadCatalog(session: AnalysisSession, token: vscode.CancellationToken): Promise<DefinitionCatalogSnapshot> {
        const snapshot: DefinitionCatalogSnapshot = { definitions: [], objects: [], issues: [] };
        let totalBytes = 0;
        const definitionMap = new Map<string, { object: ObjectReference; sql: string }>();
        for (const kind of ['VIEW', 'PROCEDURE', 'TABLE', 'EXTERNAL TABLE'] as const) {
            try {
                const query = kind === 'VIEW' ? NZ_QUERIES.listViewDefinitions(session.database) : kind === 'PROCEDURE' ? NZ_QUERIES.listProcedureSources(session.database) : kind === 'EXTERNAL TABLE' ? NZ_QUERIES.listExternalTables([session.database]) : NZ_QUERIES.listTablesAndViews([session.database]);
                const rows = await session.rows(query);
                if (rows.length > MAX_OBJECTS) { snapshot.issues.push(`${kind} catalog exceeded ${MAX_OBJECTS} objects; analysis is partial.`); }
                for (const row of rows.slice(0, MAX_OBJECTS)) {
                    const object: ObjectReference = { database: session.database, schema: text(row, 'SCHEMA'), name: text(row, kind === 'VIEW' ? 'VIEWNAME' : kind === 'PROCEDURE' ? 'PROCEDURE' : 'OBJNAME'), type: kind === 'TABLE' ? (text(row, 'OBJTYPE') === 'VIEW' ? 'VIEW' : text(row, 'OBJTYPE') === 'TABLE' ? 'TABLE' : 'UNKNOWN') : kind };
                    if (!object.name) { continue; }
                    snapshot.objects.push(object);
                    if (kind === 'TABLE' || kind === 'EXTERNAL TABLE') { continue; }
                    let sql = text(row, kind === 'VIEW' ? 'DEFINITION' : 'PROCEDURESOURCE');
                    if (!sql) { snapshot.issues.push(`${object.name}: definition unavailable (permissions or catalog visibility).`); continue; }
                    if (kind === 'PROCEDURE' && !/^\s*CREATE\s/i.test(sql)) {
                        sql = wrapProcedureStringBody(sql.replace(/^\s*BEGIN_PROC\b/i, '').replace(/\bEND_PROC\s*;?\s*$/i, ''));
                    }
                    totalBytes += Buffer.byteLength(sql, 'utf8');
                    if (totalBytes > 32_000_000) { snapshot.issues.push('Definition catalog exceeded 32 MB; analysis is partial.'); break; }
                    const existing = definitionMap.get(objectId(object));
                    if (existing) { existing.sql += `\n${sql}`; snapshot.issues.push(`${object.name}: overloaded routines are aggregated; calls are not resolved by signature.`); }
                    else { const definition = { object, sql }; snapshot.definitions.push(definition); definitionMap.set(objectId(object), definition); }
                }
            } catch (error) {
                if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
                snapshot.issues.push(`${kind} catalog unavailable: ${errorText(error)}`);
            }
        }
        if (!this.cache.getForeignKeyRelationshipsForDatabase(session.connectionName, session.database)?.complete) {
            const generation = this.generation;
            try {
                const rows = await session.rows(NZ_QUERIES.listForeignKeyColumnReferences(session.database), 50_001);
                if (token.isCancellationRequested || this.disposed || generation !== this.generation) throw new vscode.CancellationError();
                if (rows.length >= 50_001) { snapshot.issues.push('Foreign-key catalog truncated; constraints remain partial.'); }
                else { this.cache.setForeignKeyRelationshipsForDatabase(session.connectionName, session.database, normalizeForeignKeyRelationshipRows(rows, session.database), true); }
            } catch (error) {
                if (token.isCancellationRequested || this.disposed || generation !== this.generation) throw new vscode.CancellationError();
                snapshot.issues.push(`Foreign-key catalog unavailable: ${errorText(error)}`);
            }
        }
        return snapshot;
    }
    async performance(connection: string, sql: string, context: ObjectReference, token: vscode.CancellationToken, measureSkew = false): Promise<PerformanceReport> {
        const analysis = analyzeSql(sql, context);
        const issues: string[] = context.schema ? [] : ['Default schema is unknown; unqualified references cannot be resolved reliably.'];
        const tables = new Map<string, PerformanceTable>();
        for (const reference of analysis.references.filter(r => r.kind === 'object')) {
            const columns = reference.target.schema ? this.cache.getColumns(connection,
                buildColumnCacheKey(reference.target.database, reference.target.schema, reference.target.name, { preserveCase: true, exactNetezza: true })) : undefined;
            tables.set(objectId(reference.target), { object: reference.target,
                columns: columns?.map(c => ({ name: c.ATTNAME, type: c.FORMAT_TYPE })),
                distributionKeys: columns?.filter(c => c.isDistributionKey).map(c => c.ATTNAME) });
        }
        let explainPlanText: string | undefined;
        let plan: ExplainPlanSemanticAnalysis | undefined;
        try {
            await this.withSession(connection, context.database, token, async (session, activeToken) => {
                for (const database of new Set([...tables.values()].map(table => table.object.database))) {
                    if ([...tables.values()].filter(t => t.object.database === database).every(t => t.columns?.length && t.distributionKeys !== undefined)) { continue; }
                    try {
                        const queries = buildNetezzaColumnsWithKeysQueries(database);
                        const columns = await session.rows(queries.columns, 50_001);
                        const distribution = await session.rows(queries.distribution, 50_001);
                        if (columns.length >= 50_001 || distribution.length >= 50_001) { issues.push(`${database}: metadata truncated; unobserved columns remain unknown.`); continue; }
                        const merged = mergeNetezzaColumnsWithKeysRows(columns, [], distribution);
                        for (const table of tables.values()) {
                            if (table.object.database !== database) { continue; }
                            const matching = merged.filter(c => text(c, 'TABLENAME') === table.object.name && text(c, 'SCHEMA') === table.object.schema);
                            if (matching.length) {
                                this.cache.setColumns(connection, buildColumnCacheKey(table.object.database, table.object.schema, table.object.name, { preserveCase: true, exactNetezza: true }), matching.map(row => mapRawColumnRowToMetadata({ TABLENAME: text(row, 'TABLENAME'), ATTNAME: text(row, 'ATTNAME'), FORMAT_TYPE: text(row, 'FORMAT_TYPE'), SCHEMA: text(row, 'SCHEMA'), DBNAME: text(row, 'DBNAME'), IS_DISTRIBUTION_KEY: Number(row.IS_DISTRIBUTION_KEY) })));
                                table.columns = matching.map(c => ({ name: text(c, 'ATTNAME'), type: text(c, 'FORMAT_TYPE') }));
                                table.distributionKeys = matching.filter(c => c.IS_DISTRIBUTION_KEY === 1).map(c => text(c, 'ATTNAME'));
                            }
                        }
                    } catch (error) { if (activeToken.isCancellationRequested) { throw error; } issues.push(`${database}: column/distribution metadata unavailable: ${errorText(error)}`); }
                }
                try { explainPlanText = await session.explain(sql); }
                catch (error) { if (activeToken.isCancellationRequested) { throw error; } issues.push(`EXPLAIN failed: ${errorText(error)}`); }
                plan = explainPlanText ? analyzeExplainPlanSemantic(explainPlanText) : undefined;
                for (const table of tables.values()) {
                    const nodes = plan?.nodes.filter(n => n.table === table.object.name || n.table === `${table.object.schema}.${table.object.name}` || n.table === `${table.object.database}.${table.object.schema}.${table.object.name}`) ?? [];
                    if (nodes.length) { table.rows = Math.max(...nodes.map(n => n.rows)); }
                }
                if (measureSkew) {
                    if (tables.size > 10) { issues.push('Skew measurements are bounded to the first 10 referenced tables.'); }
                    issues.push('Skew measurement covers populated slices; empty slices are not represented, so the ratio is a lower bound.');
                    const provider = (await import('../../core/connectionFactory')).getRequiredDatabaseDdlProvider('netezza');
                    for (const table of [...tables.values()].slice(0, 10)) {
                        try {
                            const rows = await session.rows(provider.buildSkewCheckQuery([table.object.database, table.object.schema, table.object.name].map(part => '"' + part.replace(/"/g, '""') + '"').join('.')), 10_000);
                            if (rows.length >= 10_000) { issues.push(`${table.object.name}: slice count truncated; skew is unknown.`); continue; }
                            table.skewCoverage = 'populated-slices';
                            const counts = rows.map(row => Number(row.CNT ?? row.ROW_COUNT ?? Object.values(row)[1])).filter(n => Number.isFinite(n));
                            if (counts.length) {
                                table.averageRowsPerSlice = counts.reduce((a,b) => a+b, 0) / counts.length;
                                table.maximumRowsPerSlice = Math.max(...counts);
                                table.skewRatio = table.averageRowsPerSlice ? table.maximumRowsPerSlice / table.averageRowsPerSlice : 0;
                                table.rows = counts.reduce((a,b) => a+b, 0);
                            }
                        } catch (error) { if (activeToken.isCancellationRequested) { throw error; } issues.push(`${table.object.name}: skew measurement failed: ${errorText(error)}`); }
                    }
                } else { issues.push('Skew was not measured. “Measure skew” scans referenced tables explicitly.'); }
            });
        } catch (error) {
            if (token.isCancellationRequested || this.disposed) { throw new vscode.CancellationError(); }
            issues.push(`Metadata/EXPLAIN session unavailable: ${errorText(error)}`);
        }
        return new NetezzaTuningAdvisor().analyzePerformance({ sql, context, analysis, tables: [...tables.values()], explainPlanText, plan, issues });
    }
}
