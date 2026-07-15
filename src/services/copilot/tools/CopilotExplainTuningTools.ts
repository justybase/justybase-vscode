import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import { getRequiredDatabaseTuningAdvisor } from '../../../core/connectionFactory';
import { runExplainQuery } from '../../../core/queryRunner';
import {
    analyzeExplainPlanSemantic,
    collectExplainHotspotNextActions
} from '../../tuning/explainPlanSemanticAnalyzer';
import { TableReferenceExtractor } from '../TableReferenceExtractor';
import { buildSafeExplainSql } from '../../copilotTools/aiSqlSafety';
import { CopilotToolRuntime } from './copilotToolRuntime';

interface ResolvedTableReference {
    database: string;
    schema?: string;
    table: string;
    tableArgument: string;
    fullTableName: string;
}

interface CopilotExplainTuningToolsDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    runtime: CopilotToolRuntime;
    getTableStats: (tableName: string, database?: string) => Promise<string>;
}

export class CopilotExplainTuningTools {
    constructor(private readonly deps: CopilotExplainTuningToolsDeps) { }

    async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        const activeConn = this.deps.connectionManager.getActiveConnectionName();
        if (!activeConn) throw new Error('No active connection');

        const explainSql = buildSafeExplainSql(sql, verbose);

        const scopedDatabase = this.deps.runtime.normalizeScopeDatabase(database);
        const plan = scopedDatabase
            ? await this.deps.runtime.runExplainInDatabaseScope(explainSql, scopedDatabase)
            : await runExplainQuery(this.deps.context, explainSql, activeConn, this.deps.connectionManager, undefined);
        return plan || 'No execution plan returned';
    }

    async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        const normalizedSql = sql.trim();
        const explainSql = buildSafeExplainSql(normalizedSql, verbose);
        const plan = await this.getExplainPlan(normalizedSql, verbose, database);
        const analysis = analyzeExplainPlanSemantic(plan);

        const parseWarning =
            analysis.summary.parseCoverage.totalLines > 0 && analysis.summary.parseCoverage.matchedLines === 0
                ? 'EXPLAIN returned output, but no semantic nodes could be parsed.'
                : undefined;
        const nextActions = collectExplainHotspotNextActions(analysis.hotspots);

        return this.deps.runtime.formatStructuredToolResponse({
            summary:
                `EXPLAIN semantic analysis completed: ${analysis.summary.nodeCount} node(s), ` +
                `${analysis.hotspots.length} hotspot(s), risk ${analysis.summary.overallRisk}.`,
            data: {
                databaseScope: this.deps.runtime.normalizeScopeDatabase(database) || 'active connection database',
                explainSql,
                verbose,
                summary: analysis.summary,
                graph: {
                    nodes: analysis.nodes,
                    edges: analysis.edges
                },
                hotspots: analysis.hotspots,
                rawPlan: plan
            },
            errors: parseWarning ? [parseWarning] : undefined,
            nextActions: nextActions.length > 0
                ? nextActions
                : ['Review highest-cost operator and re-run EXPLAIN VERBOSE after each change.']
        });
    }

    private async resolveTuningTableReferences(
        sqlToAnalyze: string,
        database?: string,
        analyzeAllTables: boolean = true,
        maxTables: number = 5
    ): Promise<{ resolved: ResolvedTableReference[]; errors: string[]; truncated: boolean }> {
        const errors: string[] = [];
        const tableExtractor = new TableReferenceExtractor();
        const tableRefs = tableExtractor.extract(sqlToAnalyze);
        if (tableRefs.length === 0) {
            return {
                resolved: [],
                errors: ['No table references detected in SQL; table statistics were skipped.'],
                truncated: false
            };
        }

        const activeConnection = this.deps.connectionManager.getActiveConnectionName();
        const currentDatabase = activeConnection
            ? await this.deps.connectionManager.getCurrentDatabase(activeConnection) || undefined
            : undefined;
        const preferredDatabase = this.deps.runtime.normalizeScopeDatabase(database)?.toUpperCase();
        const upperLimit = Math.min(20, Math.max(1, maxTables));

        const uniqueRefs = new Map<string, ResolvedTableReference>();
        for (const tableRef of tableRefs) {
            const table = tableRef.name?.trim().toUpperCase();
            const schema = tableRef.schema?.trim().toUpperCase() || undefined;
            const refDatabase = tableRef.database?.trim().toUpperCase() || undefined;
            const targetDatabase = (refDatabase || preferredDatabase || currentDatabase || '').toUpperCase();

            if (!table || !targetDatabase) {
                errors.push('Could not determine table/database for table statistics lookup.');
                continue;
            }

            const tableArgument = schema ? `${schema}.${table}` : table;
            const fullTableName = schema ? `${targetDatabase}.${schema}.${table}` : `${targetDatabase}..${table}`;
            if (!uniqueRefs.has(fullTableName)) {
                uniqueRefs.set(fullTableName, {
                    database: targetDatabase,
                    schema,
                    table,
                    tableArgument,
                    fullTableName
                });
            }

            if (!analyzeAllTables && uniqueRefs.size >= 1) {
                break;
            }
            if (uniqueRefs.size >= upperLimit) {
                break;
            }
        }

        return {
            resolved: Array.from(uniqueRefs.values()).slice(0, upperLimit),
            errors,
            truncated: analyzeAllTables && tableRefs.length > upperLimit
        };
    }

    async getTuningAdvice(
        sql?: string,
        database?: string,
        analyzeAllTables: boolean = true,
        maxTables: number = 5
    ): Promise<string> {
        const sqlResolution = this.deps.runtime.resolveSqlInput(sql);
        if (!sqlResolution.sql || sqlResolution.sql.trim().length === 0) {
            return this.deps.runtime.formatStructuredToolResponse({
                summary: 'Tuning analysis could not start. SQL input is missing.',
                errors: ['SQL input is required for tuning analysis.'],
                nextActions: [
                    'Provide SQL in the tool call input.',
                    'Or keep a SQL editor open with selected/current query and retry.'
                ]
            });
        }

        const errors: string[] = [];
        const sqlToAnalyze = sqlResolution.sql.trim();

        try {
            buildSafeExplainSql(sqlToAnalyze, true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.deps.runtime.formatStructuredToolResponse({
                summary: 'Tuning analysis accepts only a planner-safe SELECT statement.',
                errors: [message],
                nextActions: ['Provide exactly one SELECT or WITH ... SELECT statement without EXPLAIN.']
            });
        }

        let explainPlanText = '';
        try {
            explainPlanText = await this.getExplainPlan(sqlToAnalyze, true, database);
            if (!explainPlanText || explainPlanText.trim().length === 0 || explainPlanText === 'No execution plan returned') {
                errors.push('No execution plan returned for the analyzed SQL.');
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`Failed to retrieve EXPLAIN plan: ${msg}`);
        }

        const resolvedRefs = await this.resolveTuningTableReferences(sqlToAnalyze, database, analyzeAllTables, maxTables);
        if (resolvedRefs.errors.length > 0) {
            errors.push(...resolvedRefs.errors);
        }

        const tableStatsReports: string[] = [];
        const tableTargets: string[] = [];
        for (const ref of resolvedRefs.resolved) {
            const tableStatsText = await this.deps.getTableStats(ref.tableArgument, ref.database);
            if (
                tableStatsText.startsWith('Error ') ||
                tableStatsText.includes('No active database connection') ||
                tableStatsText.includes('not found') ||
                tableStatsText.includes('Could not determine database')
            ) {
                errors.push(`Table statistics lookup issue for ${ref.fullTableName}: ${tableStatsText}`);
                continue;
            }

            tableStatsReports.push(tableStatsText);
            tableTargets.push(ref.fullTableName);
        }

        if (resolvedRefs.resolved.length > tableTargets.length) {
            errors.push(
                `Table statistics were collected for ${tableTargets.length} of ${resolvedRefs.resolved.length} referenced table(s).`
            );
        }

        const advisor = getRequiredDatabaseTuningAdvisor(
            this.deps.connectionManager.getConnectionDatabaseKind(
                this.deps.connectionManager.getActiveConnectionName() || undefined
            )
        );
        const report = advisor.analyze({
            sql: sqlToAnalyze,
            explainPlanText,
            tableStatsText: tableStatsReports
        });

        if (resolvedRefs.truncated) {
            errors.push(`Analysis was limited to ${Math.min(20, Math.max(1, maxTables))} tables.`);
        }

        if (!analyzeAllTables && resolvedRefs.resolved.length > 1) {
            errors.push('Only the first referenced table was analyzed due to analyzeAllTables=false.');
        }

        const nextActions = Array.from(
            new Set(
                report.recommendations
                    .flatMap(recommendation => recommendation.actions)
                    .filter(action => action && action.trim().length > 0)
            )
        ).slice(0, 5);

        return this.deps.runtime.formatStructuredToolResponse({
            summary: report.summary,
            data: {
                sqlSource: sqlResolution.source,
                sqlLength: sqlToAnalyze.length,
                tableTarget: tableTargets.length > 0 ? tableTargets[0] : null,
                tableTargets,
                analyzeAllTables,
                maxTables: Math.min(20, Math.max(1, maxTables)),
                tableStatsMode: 'quick',
                hasExplainPlan: explainPlanText.trim().length > 0,
                hasTableStats: tableStatsReports.length > 0,
                analyzedTableCount: tableTargets.length,
                metadata: report.metadata,
                recommendations: report.recommendations,
                sqlPreview: sqlToAnalyze.substring(0, 280) + (sqlToAnalyze.length > 280 ? '...' : '')
            },
            errors: errors.length > 0 ? errors : undefined,
            nextActions: nextActions.length > 0
                ? nextActions
                : [
                    'Review recommendations and re-run EXPLAIN after each tuning change.',
                    'Run tuning analysis again after refreshing table statistics.'
                ]
        });
    }
}
