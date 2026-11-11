import * as vscode from 'vscode';
import type { DatabaseConnection, DatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import type { ConnectionManager } from '../core/connectionManager';
import { queryResultToRows, runQueryRaw } from '../core/queryRunner';
import type { SchemaProvider } from '../providers/schemaProvider';
import {
    extractTableDdlStatementEffect,
    type QualifiedTableTarget,
    type TableDdlImpact,
} from '../providers/parsers/tableDdlImpact';
import {
    extractMetadataDdlStatementEffect,
    type MetadataDdlImpact,
    type MetadataDdlTarget,
} from '../providers/parsers/metadataDdlImpact';
import { logWithFallback } from '../utils/logger';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';
import { netezzaMetadataProvider } from '../dialects/netezza/metadata/provider';
import {
    createConnectionRowReader,
    warmTableColumnsFromCatalog,
} from './cache/columnCacheWarmup';
import type { MetadataCache } from './cache/MetadataCache';
import { isTableCacheObjectType } from './cache/schemaTreeDataSource';
import type { RawColumnRowWithKeys } from './columnRowMapping';
import type { ProcedureMetadata } from './types';
import {
    removeTableObject,
    replaceTableObjectTypeForDatabase,
    toTableMetadata,
    upsertTableObject,
} from './cache/tableObjectMutation';

const CATALOG_TABLE_TYPES = ['TABLE', 'GLOBAL TEMP TABLE'] as const;

interface RuntimeCatalogContext {
    database: string;
    schema?: string;
}

export interface ResolvedTableTarget extends RuntimeCatalogContext {
    table: string;
}

type ResolvedTableDdlImpact =
    | { kind: 'create'; target: ResolvedTableTarget }
    | { kind: 'alter'; target: ResolvedTableTarget; renamedTarget?: ResolvedTableTarget }
    | { kind: 'drop'; target: ResolvedTableTarget };

interface RuntimeContextValue {
    database: string;
    schema?: string;
    at: number;
}

interface PendingBulkRefresh {
    connectionName: string;
    connection: DatabaseConnection;
    databaseKind: DatabaseKind;
    database: string;
    schema: string | undefined;
    objectTypes: Set<string>;
}

interface SchemaRefreshWindow {
    count: number;
    startedAt: number;
}

export interface TableDdlSynchronizerDiagnostics {
    /** Structural impacts routed eagerly to a catalog refresh. */
    refreshed: number;
    /** Structural impacts merged into a deferred batch. */
    merged: number;
    /** Statements that only patched the cache (comments, drops). */
    skipped: number;
    /** Batches currently waiting for the trailing flush. */
    pending: number;
}

interface PendingMetadataBatch {
    impacts: readonly MetadataDdlImpact[];
    runtimeContext: RuntimeContextValue | undefined;
}

interface TransactionState {
    active: boolean;
    pending: ResolvedTableDdlImpact[];
    pendingMetadata: PendingMetadataBatch[];
}

export interface SuccessfulStatementContext {
    sql: string;
    connectionName: string;
    documentUri?: string;
    connection: DatabaseConnection;
}

interface CatalogObjectRow {
    OBJNAME: string;
    SCHEMA?: string;
    OBJID?: number;
    OBJTYPE?: string;
    OWNER?: string;
    DESCRIPTION?: string;
    [key: string]: unknown;
}

async function readRows<T extends object>(
    connection: DatabaseConnection,
    sql: string,
): Promise<T[]> {
    const command = connection.createCommand(sql);
    const reader = await command.executeReader();
    const rows: T[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index++) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row as T);
        }
    } finally {
        await reader.close();
    }
    return rows;
}

function resolveTarget(
    target: QualifiedTableTarget,
    context: RuntimeCatalogContext,
    databaseKind: DatabaseKind,
): ResolvedTableTarget {
    if (databaseKind === 'access') {
        return {
            database: target.database || context.database || 'default',
            schema: undefined,
            table: target.table,
        };
    }

    return {
        database: target.database || context.database,
        schema: target.schema || context.schema,
        table: target.table,
    };
}

function resolveImpact(
    impact: TableDdlImpact,
    context: RuntimeCatalogContext,
    databaseKind: DatabaseKind,
): ResolvedTableDdlImpact {
    if (impact.kind === 'create') {
        return { kind: 'create', target: resolveTarget(impact.target, context, databaseKind) };
    }
    if (impact.kind === 'drop') {
        return { kind: 'drop', target: resolveTarget(impact.target, context, databaseKind) };
    }
    return {
        kind: 'alter',
        target: resolveTarget(impact.target, context, databaseKind),
        renamedTarget: impact.renamedTarget
            ? resolveTarget(impact.renamedTarget, context, databaseKind)
            : undefined,
    };
}

function transactionKey(connectionName: string, documentUri?: string): string {
    return `${connectionName}|${documentUri || '<no-document>'}`;
}

/** Keeps table metadata coherent after successful top-level SQL DDL. */
export class TableDdlSynchronizer {
    private readonly transactions = new Map<string, TransactionState>();
    /** Throttle eager refreshes per object. */
    private static readonly TARGET_COOLDOWN_MS = 30_000;
    /** Debounce a trailing batch so a script cannot trigger one query per statement. */
    private static readonly TRAILING_FLUSH_MS = 1_500;
    /** Above this many objects in one schema, refresh object types once instead. */
    private static readonly BULK_SCHEMA_THRESHOLD = 5;
    /** Counting window for the bulk-schema escalation. */
    private static readonly SCHEMA_REFRESH_WINDOW_MS = 30_000;
    /** Coalesce tree/LSP notifications after comment batches. */
    private static readonly NOTIFY_DEBOUNCE_MS = 250;
    private static readonly RUNTIME_CONTEXT_TTL_MS = 30_000;

    private readonly recentTargetRefreshAt = new Map<string, number>();
    private readonly schemaRefreshWindow = new Map<string, SchemaRefreshWindow>();
    private readonly pendingBulk = new Map<string, PendingBulkRefresh>();
    private readonly diagnostics = {
        refreshed: 0,
        merged: 0,
        skipped: 0,
    };
    private readonly runtimeContextCache = new Map<string, RuntimeContextValue>();
    private readonly notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private trailingTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly metadataCache: MetadataCache,
        private readonly schemaProvider: SchemaProvider,
    ) {}

    async handleStatementSucceeded(event: SuccessfulStatementContext): Promise<void> {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(event.connectionName);
        if (databaseKind !== 'netezza' && databaseKind !== 'access') {
            return;
        }

        const tableEffect = extractTableDdlStatementEffect(event.sql, databaseKind);
        const metadataEffect = tableEffect.impacts.length === 0 && !tableEffect.transactionControl
            ? extractMetadataDdlStatementEffect(event.sql, databaseKind)
            : { impacts: [] as MetadataDdlImpact[] };
        const key = transactionKey(event.connectionName, event.documentUri);
        try {
            if (tableEffect.transactionControl === 'begin') {
                this.transactions.set(key, { active: true, pending: [], pendingMetadata: [] });
                return;
            }
            if (tableEffect.transactionControl === 'rollback') {
                this.transactions.delete(key);
                return;
            }
            if (tableEffect.transactionControl === 'commit') {
                const state = this.transactions.get(key);
                this.transactions.delete(key);
                if (state?.pending.length) {
                    await this.routeTableImpacts(
                        event.connectionName,
                        event.connection,
                        databaseKind,
                        state.pending,
                    );
                }
                if (state?.pendingMetadata.length) {
                    for (const batch of state.pendingMetadata) {
                        await this.applyMetadataImpactsWithContext(
                            event.connectionName,
                            event.connection,
                            databaseKind,
                            batch.impacts,
                            batch.runtimeContext,
                        );
                    }
                }
                return;
            }

            if (tableEffect.impacts.length > 0) {
                const runtimeContext = await this.resolveRuntimeContext(
                    event.connectionName,
                    event.connection,
                    databaseKind,
                    event.documentUri,
                );
                const resolved = tableEffect.impacts.map(impact =>
                    resolveImpact(impact, runtimeContext, databaseKind),
                );
                const transaction = this.transactions.get(key);
                if (transaction?.active) {
                    transaction.pending.push(...resolved);
                    return;
                }
                await this.routeTableImpacts(
                    event.connectionName,
                    event.connection,
                    databaseKind,
                    resolved,
                );
                return;
            }

            if (metadataEffect.impacts.length > 0) {
                const transaction = this.transactions.get(key);
                if (transaction?.active) {
                    // Comments and other metadata-only DDL are transactional
                    // too: keep them out of the cache until COMMIT, and drop
                    // the whole batch on ROLLBACK.
                    const runtimeContext = await this.resolveMetadataRuntimeContext(
                        event.connectionName,
                        event.connection,
                        databaseKind,
                        event.documentUri,
                        metadataEffect.impacts,
                    );
                    transaction.pendingMetadata.push({
                        impacts: metadataEffect.impacts,
                        runtimeContext,
                    });
                    return;
                }
                await this.applyMetadataImpacts(
                    event.connectionName,
                    event.connection,
                    databaseKind,
                    event.documentUri,
                    metadataEffect.impacts,
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logWithFallback('warn', `[TableDdlSynchronizer] Metadata sync skipped: ${message}`);
        }
    }

    /**
     * Drops are cheap cache removals. Structural changes are applied eagerly
     * for the first object and coalesced afterwards, so a script that alters
     * the same object (or a whole schema) does not issue one catalog query per
     * statement.
     */
    private async routeTableImpacts(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        impacts: readonly ResolvedTableDdlImpact[],
    ): Promise<void> {
        const drops = impacts.filter(impact => impact.kind === 'drop');
        if (drops.length > 0) {
            // Drops are pure cache removals; no catalog query is required.
            this.diagnostics.skipped += drops.length;
            await this.applyImpacts(connectionName, connection, drops, databaseKind);
        }
        for (const impact of impacts) {
            if (impact.kind === 'drop') {
                continue;
            }
            await this.queueStructuralImpact(connectionName, connection, databaseKind, impact);
        }
    }

    private async queueStructuralImpact(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        impact: ResolvedTableDdlImpact,
    ): Promise<void> {
        const target = impact.kind === 'alter' && impact.renamedTarget
            ? impact.renamedTarget
            : impact.target;
        const schemaKey = this.bulkKey(connectionName, target.database, target.schema);
        const targetKey = this.targetKey(connectionName, target);
        const now = Date.now();
        const recent = this.recentTargetRefreshAt.get(targetKey);
        const window = this.schemaRefreshWindow.get(schemaKey);
        const insideWindow = window !== undefined
            && now - window.startedAt < TableDdlSynchronizer.SCHEMA_REFRESH_WINDOW_MS;
        const refreshedInSchema = insideWindow ? window.count : 0;

        if (
            this.pendingBulk.has(schemaKey)
            || (recent !== undefined && now - recent < TableDdlSynchronizer.TARGET_COOLDOWN_MS)
            || refreshedInSchema >= TableDdlSynchronizer.BULK_SCHEMA_THRESHOLD
        ) {
            this.addToBulk(
                connectionName,
                connection,
                databaseKind,
                target.database,
                target.schema,
                'TABLE',
            );
            this.metadataCache.invalidateTableColumns(
                connectionName,
                target.database,
                target.schema,
                target.table,
            );
            if (impact.kind === 'alter' && impact.renamedTarget) {
                this.metadataCache.invalidateTableColumns(
                    connectionName,
                    impact.target.database,
                    impact.target.schema,
                    impact.target.table,
                );
            }
            this.scheduleTrailingFlush();
            this.diagnostics.merged += 1;
            return;
        }

        this.schemaRefreshWindow.set(schemaKey, insideWindow
            ? { count: refreshedInSchema + 1, startedAt: window.startedAt }
            : { count: 1, startedAt: now });
        this.recentTargetRefreshAt.set(targetKey, now);
        this.diagnostics.refreshed += 1;
        await this.applyImpacts(connectionName, connection, [impact], databaseKind);
    }

    private async applyMetadataImpacts(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        documentUri: string | undefined,
        impacts: readonly MetadataDdlImpact[],
    ): Promise<void> {
        const runtimeContext = await this.resolveMetadataRuntimeContext(
            connectionName,
            connection,
            databaseKind,
            documentUri,
            impacts,
        );
        await this.applyMetadataImpactsWithContext(
            connectionName,
            connection,
            databaseKind,
            impacts,
            runtimeContext,
        );
    }

    /**
     * Resolve CURRENT_CATALOG/CURRENT_SCHEMA only when at least one impact
     * needs it. A transaction resolves it once at statement time and reuses
     * that value on COMMIT, so a later SET SCHEMA cannot retarget a buffered
     * comment.
     */
    private async resolveMetadataRuntimeContext(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        documentUri: string | undefined,
        impacts: readonly MetadataDdlImpact[],
    ): Promise<RuntimeContextValue | undefined> {
        return impacts.some(impact =>
            impact.kind !== 'comment'
            || !impact.target.database
            || impact.target.schema === undefined,
        )
            ? await this.resolveRuntimeContext(connectionName, connection, databaseKind, documentUri)
            : undefined;
    }

    private async applyMetadataImpactsWithContext(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        impacts: readonly MetadataDdlImpact[],
        runtimeContext: RuntimeContextValue | undefined,
    ): Promise<void> {
        for (const impact of impacts) {
            if (impact.kind === 'comment') {
                this.applyCommentImpact(
                    connectionName,
                    impact,
                    runtimeContext,
                );
                continue;
            }
            const target = this.resolveMetadataTarget(impact.target, runtimeContext);
            if (!target || !target.database) {
                continue;
            }
            await this.queueObjectTypeRefresh(
                connectionName,
                connection,
                databaseKind,
                target.database,
                target.schema,
                impact.objectType,
            );
        }
    }

    private applyCommentImpact(
        connectionName: string,
        impact: Extract<MetadataDdlImpact, { kind: 'comment' }>,
        runtimeContext: RuntimeContextValue | undefined,
    ): void {
        const target = this.resolveMetadataTarget(impact.target, runtimeContext);
        if (!target || !target.database) {
            return;
        }
        if (impact.objectType === 'COLUMN') {
            if (!impact.column) {
                return;
            }
            this.metadataCache.updateColumnComment(
                connectionName,
                target.database,
                target.schema,
                target.table,
                impact.column,
                impact.comment,
            );
        } else if (impact.objectType === 'PROCEDURE') {
            this.metadataCache.updateProcedureComment(
                connectionName,
                target.database,
                target.schema,
                target.table,
                impact.comment,
            );
        } else {
            this.metadataCache.updateObjectComment(
                connectionName,
                target.database,
                target.schema,
                target.table,
                impact.comment,
            );
        }
        // No catalog query: the statement already carries the new comment.
        this.diagnostics.skipped += 1;
        this.scheduleNotify(connectionName);
    }

    private async queueObjectTypeRefresh(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        database: string,
        schema: string | undefined,
        objectType: string,
    ): Promise<void> {
        const key = `${connectionName}|${database}|${objectType}`;
        const now = Date.now();
        const recent = this.recentTargetRefreshAt.get(key);
        if (recent !== undefined && now - recent < TableDdlSynchronizer.TARGET_COOLDOWN_MS) {
            this.addToBulk(connectionName, connection, databaseKind, database, schema, objectType);
            this.scheduleTrailingFlush();
            this.diagnostics.merged += 1;
            return;
        }
        this.recentTargetRefreshAt.set(key, now);
        this.diagnostics.refreshed += 1;
        await this.refreshObjectType(connectionName, database, objectType);
    }

    private addToBulk(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        database: string,
        schema: string | undefined,
        objectType: string,
    ): void {
        const key = this.bulkKey(connectionName, database, schema);
        const existing = this.pendingBulk.get(key);
        if (existing) {
            existing.objectTypes.add(objectType);
            return;
        }
        this.pendingBulk.set(key, {
            connectionName,
            connection,
            databaseKind,
            database,
            schema,
            objectTypes: new Set([objectType]),
        });
    }

    private scheduleTrailingFlush(): void {
        if (this.trailingTimer) {
            return;
        }
        this.trailingTimer = setTimeout(() => {
            this.trailingTimer = undefined;
            void this.flushPendingStructural();
        }, TableDdlSynchronizer.TRAILING_FLUSH_MS);
        (this.trailingTimer as { unref?: () => void }).unref?.();
    }

    private async flushPendingStructural(): Promise<void> {
        const bulk = [...this.pendingBulk.values()];
        this.pendingBulk.clear();

        // Multiple schemas may share the same database and object type. The
        // object-type catalog query is database-wide, so issue it once.
        const deduped = new Map<string, PendingBulkRefresh>();
        for (const entry of bulk) {
            const key = `${entry.connectionName}|${entry.database}|${entry.databaseKind}`;
            const existing = deduped.get(key);
            if (existing) {
                for (const objectType of entry.objectTypes) {
                    existing.objectTypes.add(objectType);
                }
                continue;
            }
            deduped.set(key, {
                ...entry,
                objectTypes: new Set(entry.objectTypes),
            });
        }

        for (const entry of deduped.values()) {
            for (const objectType of entry.objectTypes) {
                try {
                    this.diagnostics.refreshed += 1;
                    await this.refreshObjectType(entry.connectionName, entry.database, objectType);
                } catch (error: unknown) {
                    logWithFallback(
                        'warn',
                        `[TableDdlSynchronizer] Deferred ${objectType} refresh failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
    }

    private scheduleNotify(connectionName: string): void {
        if (this.notifyTimers.has(connectionName)) {
            return;
        }
        const timer = setTimeout(() => {
            this.notifyTimers.delete(connectionName);
            this.metadataCache.notifyMetadataChanged(connectionName);
            this.schemaProvider.refresh();
        }, TableDdlSynchronizer.NOTIFY_DEBOUNCE_MS);
        (timer as { unref?: () => void }).unref?.();
        this.notifyTimers.set(connectionName, timer);
    }

    private resolveMetadataTarget(
        target: MetadataDdlTarget,
        runtimeContext: RuntimeContextValue | undefined,
    ): ResolvedTableTarget | undefined {
        if (!target.table) {
            return undefined;
        }
        return {
            database: target.database || runtimeContext?.database || '',
            schema: target.schema ?? runtimeContext?.schema,
            table: target.table,
        };
    }

    private bulkKey(
        connectionName: string,
        database: string,
        schema: string | undefined,
    ): string {
        return `${connectionName}|${database}|${schema ?? ''}`;
    }

    private targetKey(connectionName: string, target: ResolvedTableTarget): string {
        return `${connectionName}|${target.database}|${target.schema ?? ''}|${target.table}`;
    }

    /**
     * Resolve CURRENT_CATALOG/CURRENT_SCHEMA once per document window. The old
     * path issued this query for every DDL statement, which made a 100-statement
     * script pay 100 extra metadata round-trips.
     */
    private async resolveRuntimeContext(
        connectionName: string,
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
        documentUri: string | undefined,
    ): Promise<RuntimeContextValue> {
        const key = `${connectionName}|${documentUri ?? '<no-document>'}`;
        const cached = this.runtimeContextCache.get(key);
        if (cached && Date.now() - cached.at < TableDdlSynchronizer.RUNTIME_CONTEXT_TTL_MS) {
            return cached;
        }
        const context = await this.readRuntimeContext(connection, databaseKind);
        const value: RuntimeContextValue = { ...context, at: Date.now() };
        this.runtimeContextCache.set(key, value);
        return value;
    }

    /** DDL coalescing counters for the metadata stats report. */
    getDiagnostics(): TableDdlSynchronizerDiagnostics {
        return {
            ...this.diagnostics,
            pending: this.pendingBulk.size,
        };
    }

    /** Release timers so an extension deactivate cannot keep a Node handle alive. */
    dispose(): void {        if (this.trailingTimer) {
            clearTimeout(this.trailingTimer);
            this.trailingTimer = undefined;
        }
        for (const timer of this.notifyTimers.values()) {
            clearTimeout(timer);
        }
        this.notifyTimers.clear();
        this.pendingBulk.clear();
        this.runtimeContextCache.clear();
        this.recentTargetRefreshAt.clear();
        this.schemaRefreshWindow.clear();
    }


    handleExecutionFailure(connectionName: string, documentUri?: string): void {
        this.transactions.delete(transactionKey(connectionName, documentUri));
    }

    async refreshObjectType(
        connectionName: string,
        database: string,
        objectType: string,
    ): Promise<void> {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind(connectionName);
        const provider = getDatabaseMetadataProvider(databaseKind);
        const normalizedType = objectType.trim().toUpperCase();
        const result = await runQueryRaw({
            context: this.context,
            query: provider.buildObjectTypeQuery(database, normalizedType),
            silent: true,
            connectionManager: this.connectionManager,
            connectionName,
            isUserQuery: false,
            metadataContext: {
                source: 'ddl-sync',
                kind: 'objects',
                connectionName,
                database,
                reason: `refresh-object-type:${normalizedType}`,
            },
        });
        const rows = queryResultToRows<CatalogObjectRow>(result);

        if (normalizedType === 'PROCEDURE') {
            const procedures: ProcedureMetadata[] = rows.map(row => ({
                PROCEDURE: row.OBJNAME,
                PROCEDURESIGNATURE: row.OBJNAME,
                SCHEMA: row.SCHEMA,
                OWNER: row.OWNER,
                DESCRIPTION: normalizeCompletionDescription(row.DESCRIPTION),
                label: row.OBJNAME,
                kind: vscode.CompletionItemKind.Function,
                objType: 'PROCEDURE',
                detail: row.SCHEMA ? `PROCEDURE (${row.SCHEMA})` : 'PROCEDURE',
                sortText: row.OBJNAME,
            }));
            this.metadataCache.setProcedures(connectionName, `${database}..`, procedures);
            this.metadataCache.markProcedureCatalogLoaded(connectionName, database);
        } else if (isTableCacheObjectType(normalizedType)) {
            replaceTableObjectTypeForDatabase(
                this.metadataCache,
                connectionName,
                database,
                normalizedType,
                rows.map(row => toTableMetadata({ ...row, OBJTYPE: normalizedType })),
                { flatCatalog: databaseKind === 'access' },
            );
        }

        this.metadataCache.notifyMetadataChanged(connectionName);
        this.schemaProvider.refresh();
    }

    async refreshObject(
        connectionName: string,
        target: ResolvedTableTarget,
    ): Promise<void> {
        if (this.connectionManager.getConnectionDatabaseKind(connectionName) !== 'netezza') {
            await this.refreshObjectType(connectionName, target.database, 'TABLE');
            return;
        }

        const provider = netezzaMetadataProvider;
        const query = provider.buildObjectByNameQuery(
            target.database,
            target.schema ?? '',
            target.table,
            CATALOG_TABLE_TYPES,
        );
        const result = await runQueryRaw({
            context: this.context,
            query,
            silent: true,
            connectionManager: this.connectionManager,
            connectionName,
            isUserQuery: false,
            metadataContext: {
                source: 'ddl-sync',
                kind: 'objects',
                connectionName,
                database: target.database,
                schema: target.schema,
                table: target.table,
                reason: 'refresh-object-after-ddl',
            },
        });
        const row = queryResultToRows<CatalogObjectRow>(result)[0];
        this.applyCatalogRow(connectionName, target, row);
        if (row) {
            await warmTableColumnsFromCatalog(
                this.metadataCache,
                connectionName,
                target,
                async sql => queryResultToRows<RawColumnRowWithKeys>(await runQueryRaw({
                    context: this.context,
                    query: sql,
                    silent: true,
                    connectionManager: this.connectionManager,
                    connectionName,
                    isUserQuery: false,
                    metadataContext: {
                        source: 'ddl-sync',
                        kind: 'columns',
                        connectionName,
                        database: target.database,
                        schema: target.schema,
                        table: target.table,
                        reason: 'warm-columns-after-ddl',
                    },
                })),
            );
        }
        this.metadataCache.notifyMetadataChanged(connectionName);
        this.schemaProvider.refresh();
    }

    private async readRuntimeContext(
        connection: DatabaseConnection,
        databaseKind: DatabaseKind,
    ): Promise<RuntimeCatalogContext> {
        if (databaseKind === 'access') {
            return { database: 'default' };
        }

        const rows = await readRows<{ DATABASE: string; SCHEMA: string }>(
            connection,
            'SELECT CURRENT_CATALOG AS DATABASE, CURRENT_SCHEMA AS SCHEMA',
        );
        const current = rows[0];
        if (!current?.DATABASE || !current.SCHEMA) {
            throw new Error('Unable to resolve CURRENT_CATALOG/CURRENT_SCHEMA after DDL');
        }
        return { database: current.DATABASE, schema: current.SCHEMA };
    }

    private async applyImpacts(
        connectionName: string,
        connection: DatabaseConnection,
        impacts: readonly ResolvedTableDdlImpact[],
        databaseKind: DatabaseKind,
    ): Promise<void> {
        if (databaseKind === 'access') {
            await this.applyAccessImpacts(connectionName, connection, impacts);
            return;
        }

        const warmTargets: ResolvedTableTarget[] = [];
        const readRows = createConnectionRowReader(connection);

        for (const impact of impacts) {
            if (impact.kind === 'drop') {
                this.removeTarget(connectionName, impact.target);
                continue;
            }
            if (impact.kind === 'alter' && impact.renamedTarget) {
                this.removeTarget(connectionName, impact.target);
            }
            const lookupTarget = impact.kind === 'alter' && impact.renamedTarget
                ? impact.renamedTarget
                : impact.target;
            const row = await this.readCatalogObject(connection, lookupTarget);
            this.applyCatalogRow(connectionName, lookupTarget, row);
            if (row) {
                warmTargets.push(lookupTarget);
            }
        }

        await Promise.all(
            warmTargets.map(target =>
                warmTableColumnsFromCatalog(
                    this.metadataCache,
                    connectionName,
                    target,
                    readRows,
                ),
            ),
        );

        this.metadataCache.notifyMetadataChanged(connectionName);
        this.schemaProvider.refresh();
    }

    private async readCatalogObject(
        connection: DatabaseConnection,
        target: ResolvedTableTarget,
    ): Promise<CatalogObjectRow | undefined> {
        const provider = netezzaMetadataProvider;
        const query = provider.buildObjectByNameQuery(
            target.database,
            target.schema ?? '',
            target.table,
            CATALOG_TABLE_TYPES,
        );
        return (await readRows<CatalogObjectRow>(connection, query))[0];
    }

    private applyCatalogRow(
        connectionName: string,
        target: ResolvedTableTarget,
        row: CatalogObjectRow | undefined,
    ): void {
        this.metadataCache.invalidateTableColumns(
            connectionName,
            target.database,
            target.schema,
            target.table,
        );
        if (!row) {
            removeTableObject(
                this.metadataCache,
                connectionName,
                target.database,
                target.schema,
                target.table,
            );
            return;
        }
        upsertTableObject(
            this.metadataCache,
            connectionName,
            target.database,
            target.schema,
            toTableMetadata(row),
        );
        if (row.OBJTYPE) {
            const groups = this.metadataCache.getTypeGroups(connectionName, target.database) ?? [];
            this.metadataCache.setTypeGroups(connectionName, target.database, [...groups, row.OBJTYPE]);
        }
    }

    private removeTarget(connectionName: string, target: ResolvedTableTarget): void {
        removeTableObject(
            this.metadataCache,
            connectionName,
            target.database,
            target.schema,
            target.table,
        );
        this.metadataCache.invalidateTableColumns(
            connectionName,
            target.database,
            target.schema,
            target.table,
        );
    }

    private async applyAccessImpacts(
        connectionName: string,
        connection: DatabaseConnection,
        impacts: readonly ResolvedTableDdlImpact[],
    ): Promise<void> {
        const provider = getDatabaseMetadataProvider('access');
        const warmTargets: ResolvedTableTarget[] = [];

        for (const impact of impacts) {
            if (impact.kind === 'drop') {
                this.removeTarget(connectionName, impact.target);
                continue;
            }

            if (impact.kind === 'alter' && impact.renamedTarget) {
                this.removeTarget(connectionName, impact.target);
            }

            const target = impact.kind === 'alter' && impact.renamedTarget
                ? impact.renamedTarget
                : impact.target;
            this.metadataCache.invalidateTableColumns(
                connectionName,
                target.database,
                undefined,
                target.table,
            );
            warmTargets.push(target);
        }

        const databases = new Set(impacts.map(impact => impact.target.database));
        const catalogRowsByDatabase = new Map<string, CatalogObjectRow[]>();
        for (const database of databases) {
            const rows = await readRows<CatalogObjectRow>(
                connection,
                provider.buildObjectTypeQuery(database, 'TABLE'),
            );
            catalogRowsByDatabase.set(database, rows);
            replaceTableObjectTypeForDatabase(
                this.metadataCache,
                connectionName,
                database,
                'TABLE',
                rows.map(row => toTableMetadata({ ...row, OBJTYPE: 'TABLE' })),
                { flatCatalog: true },
            );
        }

        const readColumnRows = createConnectionRowReader(connection);
        await Promise.all(
            warmTargets
                .filter(target => catalogRowsByDatabase.get(target.database)?.some(
                    row => row.OBJNAME.toUpperCase() === target.table.toUpperCase(),
                ))
                .map(target => warmTableColumnsFromCatalog(
                    this.metadataCache,
                    connectionName,
                    target,
                    readColumnRows,
                    'access',
                )),
        );

        this.metadataCache.notifyMetadataChanged(connectionName);
        this.schemaProvider.refresh();
    }
}
