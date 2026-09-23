import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryExecutionResultPanel } from '../commands/query/queryExecutionGate';
import { tryAcquireQueryExecution, markQueryExecutionCancelling } from '../commands/query/queryExecutionGate';
import { createQueryExecutionRecovery } from '../commands/query/queryExecutionRecovery';
import { cancelQueryByUri, runQueryRaw } from '../core/queryRunner';
import { getCachedColumnsFromMetadataCacheAsync } from '../metadata/columnCacheLookup';
import type { ColumnMetadata } from '../metadata/types';
import type { ResultSet } from '../types';
import type { ResultStateManager } from '../state/resultStateManager';
import {
    buildRelatedRowsSql,
    findRelatedRowCandidates,
    type RelatedRowColumn,
    type RelatedRowTable,
} from './relatedRows';

export interface RelatedRowsNavigationHost {
    connectionManager?: ConnectionManager;
    context?: vscode.ExtensionContext;
    stateManager: ResultStateManager;
    executionPanel: QueryExecutionResultPanel;
    resolveConnectionName(sourceUri: string): string;
    setActiveSource(sourceUri: string): void;
    log(sourceUri: string, message: string): void;
    updateWebview(): void;
}

function toRelatedRowColumn(column: ColumnMetadata): RelatedRowColumn {
    return {
        name: column.ATTNAME,
        type: column.FORMAT_TYPE,
        isPk: column.isPk,
        isFk: column.isFk,
    };
}

/** Resolve cached relationships and run a bounded, read-only related-row query. */
export async function openRelatedRowsFromCell(
    host: RelatedRowsNavigationHost,
    sourceUri: string,
    resultSetIndex: number,
    rowIndex: number,
    columnIndex: number,
): Promise<void> {
    try {
        const { connectionManager, context, stateManager } = host;
        if (!connectionManager || !context) {
            throw new Error('Related-row navigation is not available in this result panel.');
        }
        const resultSet = stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const editSource = resultSet?.editSource;
        if (!resultSet || !resultSet.isEditable || resultSet.storageMode === 'sqlite'
            || !editSource || !Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)
            || rowIndex < 0 || rowIndex >= resultSet.data.length
            || columnIndex < 0 || columnIndex >= resultSet.columns.length) {
            throw new Error('Related rows are available only for cells in a direct table result.');
        }

        const sourceColumnName = resultSet.columns[columnIndex]?.name;
        const sourceValue = resultSet.data[rowIndex]?.[columnIndex];
        if (!sourceColumnName || sourceValue === null || sourceValue === undefined) {
            throw new Error('The selected cell does not contain a value to match.');
        }
        const connectionName = host.resolveConnectionName(sourceUri);
        const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
        const database = editSource.db
            || await connectionManager.getEffectiveDatabase(sourceUri, connectionName)
            || '';
        const schema = editSource.schema
            || await connectionManager.getEffectiveSchema(sourceUri, connectionName)
            || undefined;
        if (!database) throw new Error('Unable to resolve the source database.');

        const metadataCache = connectionManager.getMetadataCache();
        if (!metadataCache) throw new Error('Table metadata is not available.');

        const sourceMetadata = await getCachedColumnsFromMetadataCacheAsync(
            metadataCache,
            connectionName,
            database,
            schema,
            editSource.table,
            databaseKind,
        );
        const sourceMetadataColumn = sourceMetadata?.find((column) =>
            column.ATTNAME.toUpperCase() === sourceColumnName.toUpperCase(),
        );
        const sourceColumn: RelatedRowColumn = sourceMetadataColumn
            ? toRelatedRowColumn(sourceMetadataColumn)
            : { name: sourceColumnName, type: resultSet.columns[columnIndex]?.type };
        const sourceTable: RelatedRowTable = {
            database,
            schema,
            table: editSource.table,
            columns: sourceMetadata?.map(toRelatedRowColumn) ?? [sourceColumn],
        };

        const tableEntries = metadataCache.getTablesAllSchemas(connectionName, database) ?? [];
        const candidateEntries = tableEntries
            .map((entry) => ({
                table: String(entry.TABLENAME ?? entry.OBJNAME ?? '').trim(),
                schema: typeof entry.SCHEMA === 'string' && entry.SCHEMA.trim() ? entry.SCHEMA.trim() : undefined,
            }))
            .filter((entry) => Boolean(entry.table))
            .slice(0, 500);
        const candidates: RelatedRowTable[] = [];
        for (let offset = 0; offset < candidateEntries.length; offset += 8) {
            const batch = candidateEntries.slice(offset, offset + 8);
            const loaded = await Promise.all(batch.map(async (entry): Promise<RelatedRowTable | undefined> => {
                const columns = await getCachedColumnsFromMetadataCacheAsync(
                    metadataCache,
                    connectionName,
                    database,
                    entry.schema,
                    entry.table,
                    databaseKind,
                );
                if (!columns?.length) return undefined;
                return {
                    database,
                    schema: entry.schema,
                    table: entry.table,
                    columns: columns.map(toRelatedRowColumn),
                };
            }));
            candidates.push(...loaded.filter((entry): entry is RelatedRowTable => Boolean(entry)));
        }

        const related = findRelatedRowCandidates(sourceTable, sourceColumn, candidates);
        if (related.length === 0) {
            vscode.window.showInformationMessage('No related table was found in the loaded metadata.');
            return;
        }
        const selected = related.length === 1
            ? related[0]
            : await vscode.window.showQuickPick(
                related.map((candidate) => ({
                    label: `${candidate.table}.${candidate.targetColumn.name}`,
                    description: [candidate.database, candidate.schema].filter(Boolean).join('.'),
                    detail: `${candidate.direction === 'referenced' ? 'Referenced rows' : candidate.direction === 'referencing' ? 'Referencing rows' : 'Matching rows'} · ${candidate.confidence === 'key' ? 'key metadata' : 'exact name match'}`,
                    candidate,
                })),
                { placeHolder: 'Choose a related table', matchOnDescription: true, matchOnDetail: true },
            ).then((item) => item?.candidate);
        if (!selected) return;

        const query = buildRelatedRowsSql({
            database: selected.database,
            schema: selected.schema,
            table: selected.table,
            column: selected.targetColumn.name,
            dataType: selected.targetColumn.type ?? sourceColumn.type,
            value: sourceValue,
            databaseKind,
            limit: 100,
        });
        await executeRelatedRowsQuery(
            host,
            sourceUri,
            connectionName,
            query,
            selected.table,
            selected.targetColumn.name,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not open related rows: ${message}`);
    }
}

async function executeRelatedRowsQuery(
    host: RelatedRowsNavigationHost,
    sourceUri: string,
    connectionName: string,
    query: string,
    targetTable: string,
    targetColumn: string,
): Promise<void> {
    const { connectionManager, context, stateManager } = host;
    if (!connectionManager || !context) return;
    const sourceDocument = vscode.workspace.textDocuments?.find(
        (document) => document.uri.toString() === sourceUri,
    );
    const lease = await tryAcquireQueryExecution(sourceUri, host.executionPanel, {
        document: sourceDocument,
        origin: 'Related rows',
        recovery: createQueryExecutionRecovery(connectionManager, sourceUri, connectionName),
    });
    if (!lease) return;
    if (!stateManager.startAuxiliaryExecution(sourceUri)) {
        lease.dispose();
        return;
    }

    host.setActiveSource(sourceUri);
    host.log(sourceUri, `Loading related rows from ${targetTable}.${targetColumn}...`);
    let cancellation: vscode.Disposable | undefined;
    let cancelRequested = false;
    try {
        let result: ResultSet | undefined;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading related rows from ${targetTable}...`,
                cancellable: true,
            },
            async (_progress, token) => {
                cancellation = token.onCancellationRequested(() => {
                    cancelRequested = true;
                    lease.markCancelling();
                    markQueryExecutionCancelling(sourceUri);
                    void cancelQueryByUri(sourceUri).catch(() => undefined);
                });
                if (cancelRequested) return;
                lease.markRunning();
                result = await runQueryRaw({
                    context,
                    query,
                    silent: true,
                    connectionManager,
                    connectionName,
                    documentUri: sourceUri,
                    maxRows: 100,
                    timeoutSeconds: 60,
                    isUserQuery: false,
                    isExecutionCurrent: () => lease.isCurrent(),
                    logCallback: () => undefined,
                });
            },
        );
        if (cancelRequested) {
            host.log(sourceUri, 'Related-row query cancelled.');
            return;
        }
        if (!result || !lease.isCurrent()) return;
        const relatedResult: ResultSet = {
            ...result,
            sql: undefined,
            refreshSql: undefined,
            expandedSql: undefined,
            name: `Related: ${targetTable}.${targetColumn}`,
            executionTimestamp: Date.now(),
            isEditable: false,
        };
        stateManager.appendAuxiliaryResultSet(sourceUri, relatedResult);
        host.log(sourceUri, `Loaded ${result.data.length} related row(s) from ${targetTable}.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/cancel/i.test(message)) {
            host.log(sourceUri, 'Related-row query cancelled.');
        } else {
            host.log(sourceUri, `Related-row query failed: ${message}`);
            vscode.window.showErrorMessage(`Related-row query failed: ${message}`);
        }
    } finally {
        cancellation?.dispose();
        lease.dispose();
        stateManager.finishAuxiliaryExecution(sourceUri);
        host.updateWebview();
    }
}
