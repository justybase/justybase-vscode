import * as vscode from 'vscode';
import type { DatabaseConnection } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import type { ConnectionManager } from '../core/connectionManager';
import { queryResultToRows, runQueryRaw } from '../core/queryRunner';
import type { SchemaProvider } from '../providers/schemaProvider';
import {
    extractTableDdlStatementEffect,
    type QualifiedTableTarget,
    type TableDdlImpact,
} from '../providers/parsers/tableDdlImpact';
import { logWithFallback } from '../utils/logger';
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
    schema: string;
}

export interface ResolvedTableTarget extends RuntimeCatalogContext {
    table: string;
}

type ResolvedTableDdlImpact =
    | { kind: 'create'; target: ResolvedTableTarget }
    | { kind: 'alter'; target: ResolvedTableTarget; renamedTarget?: ResolvedTableTarget }
    | { kind: 'drop'; target: ResolvedTableTarget };

interface TransactionState {
    active: boolean;
    pending: ResolvedTableDdlImpact[];
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
): ResolvedTableTarget {
    return {
        database: target.database || context.database,
        schema: target.schema || context.schema,
        table: target.table,
    };
}

function resolveImpact(
    impact: TableDdlImpact,
    context: RuntimeCatalogContext,
): ResolvedTableDdlImpact {
    if (impact.kind === 'create') {
        return { kind: 'create', target: resolveTarget(impact.target, context) };
    }
    if (impact.kind === 'drop') {
        return { kind: 'drop', target: resolveTarget(impact.target, context) };
    }
    return {
        kind: 'alter',
        target: resolveTarget(impact.target, context),
        renamedTarget: impact.renamedTarget
            ? resolveTarget(impact.renamedTarget, context)
            : undefined,
    };
}

function transactionKey(connectionName: string, documentUri?: string): string {
    return `${connectionName}|${documentUri || '<no-document>'}`;
}

/** Keeps Netezza table metadata coherent after successful top-level SQL DDL. */
export class TableDdlSynchronizer {
    private readonly transactions = new Map<string, TransactionState>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly metadataCache: MetadataCache,
        private readonly schemaProvider: SchemaProvider,
    ) {}

    async handleStatementSucceeded(event: SuccessfulStatementContext): Promise<void> {
        if (this.connectionManager.getConnectionDatabaseKind(event.connectionName) !== 'netezza') {
            return;
        }

        const effect = extractTableDdlStatementEffect(event.sql, 'netezza');
        const key = transactionKey(event.connectionName, event.documentUri);
        try {
            if (effect.transactionControl === 'begin') {
                this.transactions.set(key, { active: true, pending: [] });
                return;
            }
            if (effect.transactionControl === 'rollback') {
                this.transactions.delete(key);
                return;
            }
            if (effect.transactionControl === 'commit') {
                const state = this.transactions.get(key);
                this.transactions.delete(key);
                if (state?.pending.length) {
                    await this.applyImpacts(event.connectionName, event.connection, state.pending);
                }
                return;
            }
            if (effect.impacts.length === 0) {
                return;
            }

            const runtimeContext = await this.readRuntimeContext(event.connection);
            const resolved = effect.impacts.map(impact => resolveImpact(impact, runtimeContext));
            const transaction = this.transactions.get(key);
            if (transaction?.active) {
                transaction.pending.push(...resolved);
                return;
            }
            await this.applyImpacts(event.connectionName, event.connection, resolved);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logWithFallback('warn', `[TableDdlSynchronizer] Metadata sync skipped: ${message}`);
        }
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
        });
        const rows = queryResultToRows<CatalogObjectRow>(result);

        if (normalizedType === 'PROCEDURE') {
            const procedures: ProcedureMetadata[] = rows.map(row => ({
                PROCEDURE: row.OBJNAME,
                PROCEDURESIGNATURE: row.OBJNAME,
                SCHEMA: row.SCHEMA,
                OWNER: row.OWNER,
                DESCRIPTION: row.DESCRIPTION,
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
            );
        }

        this.metadataCache.notifyMetadataChanged();
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
            target.schema,
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
                })),
            );
        }
        this.metadataCache.notifyMetadataChanged();
        this.schemaProvider.refresh();
    }

    private async readRuntimeContext(connection: DatabaseConnection): Promise<RuntimeCatalogContext> {
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
    ): Promise<void> {
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

        this.metadataCache.notifyMetadataChanged();
        this.schemaProvider.refresh();
    }

    private async readCatalogObject(
        connection: DatabaseConnection,
        target: ResolvedTableTarget,
    ): Promise<CatalogObjectRow | undefined> {
        const provider = netezzaMetadataProvider;
        const query = provider.buildObjectByNameQuery(
            target.database,
            target.schema,
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
}
