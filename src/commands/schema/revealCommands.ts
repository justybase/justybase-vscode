/**
 * Schema Commands - Reveal Commands
 * Commands: revealInSchema
 */

import * as vscode from 'vscode';
import { runQueryRaw, queryResultToRows } from '../../core/queryRunner';
import { SchemaItem } from '../../providers/schemaProvider';
import { getLogger } from '../../utils/logger';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import { SchemaCommandsDependencies } from './types';
import type { DatabaseKind } from '../../contracts/database';
import { getDatabaseMetadataProvider } from '../../core/connectionFactory';
import { stripIdentifierQuoting } from '../../utils/identifierUtils';
import { isTableCacheObjectType } from '../../metadata/cache/schemaTreeDataSource';
import { toTableMetadata, upsertTableObject } from '../../metadata/cache/tableObjectMutation';
import {
    buildNetezzaIdentifierEquality,
    createNetezzaUserIdentifier,
    formatNetezzaIdentifier,
} from '../../dialects/netezza/metadata/identifierUtils';

interface RevealData {
    name: string;
    objType?: string;
    type?: string;
    parent?: string;
    database?: string;
    schema?: string;
    connectionName?: string;
}

interface GenericRevealRow {
    NAME?: string;
    TYPE?: string;
    DATABASE?: string;
    SCHEMA?: string;
    OBJID?: number;
}

interface NetezzaObjectRow extends Record<string, unknown> {
    OBJNAME: string;
    OBJTYPE: string;
    SCHEMA: string;
    OBJID: number | string;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function normalizeObjectId(value: number | string | undefined): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isTreeResolveFailure(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Cannot resolve tree item');
}

function refreshNetezzaRevealTree(
    deps: SchemaCommandsDependencies,
    logger: ReturnType<typeof resolveLogger>,
): void {
    try {
        deps.schemaProvider.refresh();
    } catch (error) {
        logger?.warn('[CQ01-REVEAL-008] Failed to refresh schema tree before reveal', error);
    }
}

function warmNetezzaRevealTarget(
    deps: SchemaCommandsDependencies,
    connectionName: string,
    database: string,
    object: NetezzaObjectRow,
    logger: ReturnType<typeof resolveLogger>,
): void {
    if (!isTableCacheObjectType(object.OBJTYPE)) {
        return;
    }

    const objectId = normalizeObjectId(object.OBJID);
    if (objectId === undefined) {
        logger?.warn(
            `[CQ01-REVEAL-007] Skipping cache warm-up for ${database}.${object.SCHEMA}.${object.OBJNAME}: invalid OBJID`,
        );
        return;
    }

    try {
        upsertTableObject(
            deps.metadataCache,
            connectionName,
            database,
            object.SCHEMA || undefined,
            toTableMetadata({
                OBJNAME: object.OBJNAME,
                OBJID: objectId,
                OBJTYPE: object.OBJTYPE,
                SCHEMA: object.SCHEMA || undefined,
            }),
        );
        // TreeView.reveal resolves against its currently loaded children. Force
        // a data refresh after warming the cache so the target becomes resolvable.
        refreshNetezzaRevealTree(deps, logger);
    } catch (error) {
        logger?.warn('[CQ01-REVEAL-007] Failed to warm reveal target into metadata cache', error);
    }
}

/**
 * Locate an object for reveal within a single Netezza database.
 *
 * Primary lookup is `_V_OBJECT_DATA` (case/whitespace-insensitive). External
 * tables are not always listed in `_V_OBJECT_DATA` (verified on dev instances),
 * so when the caller is looking for an external table (or any object) we fall
 * back to `_V_EXTERNAL`/`_V_EXTOBJECT` — the same source the schema search uses.
 */
async function findNetezzaObjectForReveal(
    deps: SchemaCommandsDependencies,
    logger: ReturnType<typeof resolveLogger>,
    connectionName: string,
    database: string,
    searchName: string,
    searchType: string | undefined,
    schemaName: string | undefined,
): Promise<NetezzaObjectRow | undefined> {
    const dbIdentifier = createNetezzaUserIdentifier(database);
    const db = formatNetezzaIdentifier(dbIdentifier);
    const escapedSchema = escapeSqlLiteral(schemaName || '');
    const escapedType = escapeSqlLiteral(searchType || '');
    const typeFilter = escapedType && escapedType !== 'COLUMN'
        ? `AND OBJTYPE = '${escapedType.toUpperCase()}'`
        : '';
    const schemaFilter = escapedSchema
        ? `AND ${buildNetezzaIdentifierEquality('SCHEMA', schemaName || '')}`
        : '';

    const objectDataQuery = `
        SELECT OBJNAME, OBJTYPE, SCHEMA, OBJID
        FROM ${db}.._V_OBJECT_DATA
        WHERE ${buildNetezzaIdentifierEquality('OBJNAME', searchName)}
        AND ${buildNetezzaIdentifierEquality('DBNAME', dbIdentifier)}
        ${typeFilter}
        ${schemaFilter}
        LIMIT 1
    `;

    try {
        const objResult = await runQueryRaw(
            deps.context,
            objectDataQuery,
            true,
            deps.connectionManager,
            connectionName,
            undefined, undefined, undefined, 1000000, false
        );
        if (objResult?.data) {
            const objects = queryResultToRows<NetezzaObjectRow>(objResult);
            if (objects.length > 0) {
                const obj = objects[0];
                obj.OBJTYPE = (obj.OBJTYPE || '').trim().toUpperCase();
                obj.OBJNAME = obj.OBJNAME || searchName;
                obj.SCHEMA = obj.SCHEMA || '';

                if (obj.OBJTYPE === 'PROCEDURE') {
                    try {
                        const sigQuery = `SELECT PROCEDURESIGNATURE FROM ${db}.._V_PROCEDURE WHERE OBJID = ${obj.OBJID}`;
                        const sigResult = await runQueryRaw(
                            deps.context,
                            sigQuery,
                            true,
                            deps.connectionManager,
                            connectionName,
                            undefined, undefined, undefined, 1000000, false
                        );
                        if (sigResult?.data && sigResult.data.length > 0) {
                            const sigObj = queryResultToRows<{ PROCEDURESIGNATURE: string }>(sigResult);
                            if (sigObj.length > 0 && sigObj[0].PROCEDURESIGNATURE) {
                                obj.OBJNAME = sigObj[0].PROCEDURESIGNATURE;
                            }
                        }
                    } catch (sigErr) {
                        logger?.warn('[CQ01-REVEAL-002] Failed to resolve procedure signature', sigErr);
                    }
                }

                return obj;
            }
        }
    } catch (e) {
        logger?.warn(`[CQ01-REVEAL-003] Error searching object in ${database}`, e);
    }

    if (!escapedType || escapedType === 'EXTERNAL TABLE') {
        const extSchemaFilter = escapedSchema
            ? `AND ${buildNetezzaIdentifierEquality('E1.SCHEMA', schemaName || '')}`
            : '';
        const extQuery = `
            SELECT E1.TABLENAME AS OBJNAME, 'EXTERNAL TABLE' AS OBJTYPE, E1.SCHEMA, E1.RELID AS OBJID
            FROM ${db}.._V_EXTERNAL E1
            JOIN ${db}.._V_EXTOBJECT E2 ON E1.RELID = E2.OBJID
            WHERE ${buildNetezzaIdentifierEquality('E1.TABLENAME', searchName)}
            AND ${buildNetezzaIdentifierEquality('E1.DATABASE', dbIdentifier)}
            ${extSchemaFilter}
            LIMIT 1
        `;

        try {
            const extResult = await runQueryRaw(
                deps.context,
                extQuery,
                true,
                deps.connectionManager,
                connectionName,
                undefined, undefined, undefined, 1000000, false
            );
            if (extResult?.data) {
                const extObjects = queryResultToRows<NetezzaObjectRow>(extResult);
                if (extObjects.length > 0) {
                    const obj = extObjects[0];
                    obj.OBJTYPE = 'EXTERNAL TABLE';
                    obj.OBJNAME = obj.OBJNAME || searchName;
                    obj.SCHEMA = obj.SCHEMA || '';
                    return obj;
                }
            }
        } catch (e) {
            logger?.warn(`[CQ01-REVEAL-006] Error searching external table in ${database}`, e);
        }
    }

    return undefined;
}

function resolveLogger() {
    try {
        return getLogger();
    } catch {
        return undefined;
    }
}

async function focusSchemaExplorer(logger: ReturnType<typeof resolveLogger>): Promise<void> {
    try {
        await vscode.commands.executeCommand('netezza.schema.focus');
    } catch (err) {
        logger?.warn('[CQ01-REVEAL-000] Failed to focus Schema Explorer before reveal', err);
    }
}

function getConnectionKind(connectionManager: SchemaCommandsDependencies['connectionManager'], connectionName: string): DatabaseKind {
    return typeof connectionManager.getConnectionDatabaseKind === 'function'
        ? connectionManager.getConnectionDatabaseKind(connectionName) ?? 'netezza'
        : 'netezza';
}

function normalizeLookupValue(value: string | undefined, kind: DatabaseKind): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? stripIdentifierQuoting(trimmed, kind) : undefined;
}

function buildEscapedLikePattern(term: string): string {
    return `%${term
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "''")
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .toUpperCase()}%`;
}

function formatRevealError(message: string, kind: DatabaseKind | undefined): string {
    if (kind !== 'access') {
        return message;
    }

    return `Microsoft Access schema could not be initialized or revealed. `
        + 'Check that the .mdb/.accdb file is accessible, the password is correct, and Java 11+ is available. '
        + `Details: ${message}`;
}

function normalizeRoutineLookupName(value: string): string {
    const trimmed = value.trim();
    const signatureIndex = trimmed.indexOf('(');
    return signatureIndex > 0 ? trimmed.substring(0, signatureIndex).trim() : trimmed;
}

function matchesGenericRevealRow(
    row: GenericRevealRow,
    searchName: string,
    searchType: string | undefined,
    schemaName: string | undefined
): boolean {
    const rowName = row.NAME?.trim();
    if (!rowName) {
        return false;
    }

    const normalizedSearchName = searchName.toUpperCase();
    const normalizedRowName = rowName.toUpperCase();
    const normalizedRowType = row.TYPE?.trim().toUpperCase();
    const effectiveSearchType = searchType && searchType !== 'COLUMN' ? searchType : undefined;
    const namesMatch = normalizedRowName === normalizedSearchName
        || normalizeRoutineLookupName(rowName).toUpperCase() === normalizedSearchName;

    if (!namesMatch) {
        return false;
    }

    if (effectiveSearchType && normalizedRowType !== effectiveSearchType) {
        return false;
    }

    if (schemaName) {
        return (row.SCHEMA?.trim().toUpperCase() || '') === schemaName.toUpperCase();
    }

    return true;
}

export function registerRevealCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, metadataCache, schemaTreeView } = deps;
    const logger = resolveLogger();
    const revealSchemaItem = async (targetItem: SchemaItem): Promise<void> => {
        await focusSchemaExplorer(logger);
        try {
            await schemaTreeView.reveal(targetItem, { select: true, focus: true });
        } catch (error) {
            if (!isTreeResolveFailure(error)) {
                throw error;
            }

            // A prior tree expansion may still hold an empty/stale child list.
            // Refresh once, then let TreeView.reveal resolve the target again.
            refreshNetezzaRevealTree(deps, logger);
            await schemaTreeView.reveal(targetItem, { select: true, focus: true });
        }
    };

    return [
        vscode.commands.registerCommand('netezza.revealInSchema', async (data: RevealData) => {
            const statusBarDisposable = vscode.window.setStatusBarMessage(
                `$(loading~spin) Revealing ${data.name} in schema...`
            );
            const revealStart = performance.now();
            const revealTimer = createPerformanceTimer('schema.reveal_in_schema', {
                payloadSize: data.name?.length ?? 0
            });
            let telemetryDone = false;
            let revealConnectionKind: DatabaseKind | undefined;
            const emitRevealTelemetry = (
                result: 'ok' | 'error' | 'cancelled',
                options?: { errorCode?: string; metadata?: Record<string, string | number | boolean | null> }
            ) => {
                if (telemetryDone) {
                    return;
                }
                telemetryDone = true;
                const event = revealTimer.finish({
                    result,
                    errorCode: options?.errorCode,
                    metadata: options?.metadata
                });
                console.log(formatPerformanceEvent(event));
            };
            try {
                let targetConnectionName: string | undefined = data.connectionName;

                if (!targetConnectionName) {
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor && activeEditor.document.languageId === 'sql') {
                        targetConnectionName = connectionManager.getConnectionForExecution(
                            activeEditor.document.uri.toString()
                        );
                    }
                }

                if (!targetConnectionName) {
                    targetConnectionName = connectionManager.getActiveConnectionName() || undefined;
                }

                if (!targetConnectionName) {
                    statusBarDisposable.dispose();
                    vscode.window.showWarningMessage('No active connection. Please select a connection first.');
                    emitRevealTelemetry('cancelled', { errorCode: 'NO_CONNECTION' });
                    return;
                }

                const connectionKind = getConnectionKind(connectionManager, targetConnectionName);
                revealConnectionKind = connectionKind;

                // Accept either `objType` (old callers) or `type` (webview payload)
                const searchType = (data.objType || data.type)?.trim().toUpperCase();
                const normalizedSchema = normalizeLookupValue(data.schema, connectionKind);
                let searchName = normalizeLookupValue(data.name, connectionKind) || data.name.trim();

                if (searchType === 'COLUMN') {
                    if (!data.parent) {
                        statusBarDisposable.dispose();
                        vscode.window.showWarningMessage('Cannot find column without parent table');
                        emitRevealTelemetry('cancelled', { errorCode: 'COLUMN_PARENT_MISSING' });
                        return;
                    }
                    searchName = normalizeLookupValue(data.parent, connectionKind) || data.parent.trim();
                }

                let targetDb = normalizeLookupValue(data.database, connectionKind);
                if (!targetDb) {
                    try {
                        targetDb = normalizeLookupValue(
                            (await connectionManager.getCurrentDatabase(targetConnectionName)) || undefined,
                            connectionKind
                        );
                    } catch (dbErr) {
                        logger?.warn('[CQ01-REVEAL-001] Failed to resolve current database for reveal', dbErr);
                    }
                }

                // Try cache first
                if (targetDb) {
                    const cachedObj = metadataCache.findObjectWithType(
                        targetConnectionName,
                        targetDb,
                        normalizedSchema,
                        searchName
                    );
                    if (cachedObj) {
                        if (connectionKind === 'netezza' && isTableCacheObjectType(cachedObj.objType)) {
                            refreshNetezzaRevealTree(deps, logger);
                        }
                        const targetItem = new SchemaItem(
                            cachedObj.name,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            `netezza:${cachedObj.objType}`,
                            targetDb,
                            cachedObj.objType,
                            cachedObj.schema || normalizedSchema,
                            cachedObj.objId,
                            undefined,
                            targetConnectionName
                        );
                        await revealSchemaItem(targetItem);
                        logger?.info(
                            `[perf] revealInSchema cache-hit (${targetDb}.${cachedObj.schema || normalizedSchema}.${searchName}) ${(performance.now() - revealStart).toFixed(1)}ms`
                        );
                        emitRevealTelemetry('ok', {
                            metadata: {
                                path: 'cache',
                                object_type: cachedObj.objType
                            }
                        });
                        statusBarDisposable.dispose();
                        vscode.window.setStatusBarMessage(
                            `$(check) Found ${searchName} in ${targetDb}.${cachedObj.schema || normalizedSchema} (cached)`,
                            3000
                        );
                        return;
                    }
                }

                const connectionDetails = await connectionManager.getConnection(targetConnectionName);
                if (!connectionDetails) {
                    statusBarDisposable.dispose();
                    vscode.window.showWarningMessage('Not connected to database and object not found in cache.');
                    emitRevealTelemetry('cancelled', { errorCode: 'NO_DB_CONNECTION' });
                    return;
                }

                if (connectionKind !== 'netezza') {
                    const metadataProvider = getDatabaseMetadataProvider(connectionKind);

                    const revealGenericObject = async (databaseName: string, path: 'database_provider' | 'cross_database_provider'): Promise<boolean> => {
                        const query = metadataProvider.buildObjectSearchQuery(databaseName, buildEscapedLikePattern(searchName));
                        const objResult = await runQueryRaw(
                            context,
                            query,
                            true,
                            connectionManager,
                            targetConnectionName,
                            undefined, undefined, undefined, 1000000, false
                        );
                        if (!objResult?.data) {
                            return false;
                        }

                        const objects = queryResultToRows<GenericRevealRow & { [key: string]: unknown }>(objResult);
                        const obj = objects.find(row => matchesGenericRevealRow(row, searchName, searchType, normalizedSchema));
                        if (!obj) {
                            return false;
                        }

                        const resolvedDb = obj.DATABASE?.trim() || databaseName;
                        const resolvedType = obj.TYPE?.trim().toUpperCase() || searchType || 'OBJECT';
                        const resolvedSchema = obj.SCHEMA?.trim() || normalizedSchema;
                        const targetItem = new SchemaItem(
                            obj.NAME?.trim() || searchName,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            `netezza:${resolvedType}`,
                            resolvedDb,
                            resolvedType,
                            resolvedSchema,
                            obj.OBJID,
                            undefined,
                            targetConnectionName
                        );

                        await revealSchemaItem(targetItem);
                        logger?.info(
                            `[perf] revealInSchema ${path} (${resolvedDb}.${resolvedSchema || ''}.${searchName}) ${(performance.now() - revealStart).toFixed(1)}ms`
                        );
                        emitRevealTelemetry('ok', {
                            metadata: {
                                path,
                                object_type: resolvedType
                            }
                        });
                        statusBarDisposable.dispose();
                        vscode.window.setStatusBarMessage(
                            `$(check) Found ${searchName} in ${resolvedDb}${resolvedSchema ? `.${resolvedSchema}` : ''}`,
                            3000
                        );
                        return true;
                    };

                    if (targetDb) {
                        if (await revealGenericObject(targetDb, 'database_provider')) {
                            return;
                        }
                    } else {
                        const dbResultRaw = await runQueryRaw(
                            context,
                            metadataProvider.buildListDatabasesQuery(),
                            true,
                            connectionManager,
                            targetConnectionName,
                            undefined, undefined, undefined, 1000000, false
                        );
                        const databases = dbResultRaw?.data
                            ? queryResultToRows<{ DATABASE?: string }>(dbResultRaw)
                                .map(row => normalizeLookupValue(row.DATABASE, connectionKind))
                                .filter((database): database is string => !!database)
                            : [];

                        if (databases.length === 0 && connectionDetails.database) {
                            const fallbackDb = normalizeLookupValue(connectionDetails.database, connectionKind);
                            if (fallbackDb) {
                                databases.push(fallbackDb);
                            }
                        }

                        for (const databaseName of databases) {
                            try {
                                if (await revealGenericObject(databaseName, 'cross_database_provider')) {
                                    return;
                                }
                            } catch (e) {
                                logger?.warn(`[CQ01-REVEAL-004] Error searching object in ${databaseName}`, e);
                            }
                        }
                    }

                    statusBarDisposable.dispose();
                    vscode.window.showWarningMessage(`Could not find ${searchType || 'object'} ${searchName}`);
                    emitRevealTelemetry('cancelled', { errorCode: 'OBJECT_NOT_FOUND' });
                    return;
                }

                if (targetDb) {
                    const obj = await findNetezzaObjectForReveal(
                        deps,
                        logger,
                        targetConnectionName,
                        targetDb,
                        searchName,
                        searchType,
                        normalizedSchema,
                    );

                    if (obj) {
                        const objectId = normalizeObjectId(obj.OBJID);
                        warmNetezzaRevealTarget(
                            deps,
                            targetConnectionName,
                            targetDb,
                            obj,
                            logger,
                        );
                        const targetItem = new SchemaItem(
                            obj.OBJNAME,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            `netezza:${obj.OBJTYPE}`,
                            targetDb,
                            obj.OBJTYPE,
                            obj.SCHEMA,
                            objectId,
                            undefined,
                            targetConnectionName
                        );

                        await revealSchemaItem(targetItem);
                        logger?.info(
                            `[perf] revealInSchema db-hit (${targetDb}.${obj.SCHEMA}.${searchName}) ${(performance.now() - revealStart).toFixed(1)}ms`
                        );
                        emitRevealTelemetry('ok', {
                            metadata: {
                                path: 'database',
                                object_type: obj.OBJTYPE
                            }
                        });
                        statusBarDisposable.dispose();
                        vscode.window.setStatusBarMessage(
                            `$(check) Found ${searchName} in ${targetDb}.${obj.SCHEMA}`,
                            3000
                        );
                        return;
                    }
                }

                // Fallback: search all databases
                if (!targetDb) {
                    const dbResultRaw = await runQueryRaw(
                        context,
                        'SELECT DATABASE FROM system.._v_database ORDER BY DATABASE',
                        true,
                        connectionManager,
                        targetConnectionName,
                        undefined, undefined, undefined, 1000000, false
                    );
                    if (dbResultRaw && dbResultRaw.data) {
                        const databases = queryResultToRows<{ DATABASE: string }>(dbResultRaw);
                        for (const db of databases) {
                            const dbName = db.DATABASE;
                            try {
                                const obj = await findNetezzaObjectForReveal(
                                    deps,
                                    logger,
                                    targetConnectionName,
                                    dbName,
                                    searchName,
                                    searchType,
                                    normalizedSchema,
                                );

                                if (obj) {
                                    const objectId = normalizeObjectId(obj.OBJID);
                                    warmNetezzaRevealTarget(
                                        deps,
                                        targetConnectionName,
                                        dbName,
                                        obj,
                                        logger,
                                    );
                                    const targetItem = new SchemaItem(
                                        obj.OBJNAME,
                                        vscode.TreeItemCollapsibleState.Collapsed,
                                        `netezza:${obj.OBJTYPE}`,
                                        dbName,
                                        obj.OBJTYPE,
                                        obj.SCHEMA,
                                        objectId,
                                        undefined,
                                        targetConnectionName
                                    );

                                    await revealSchemaItem(targetItem);
                                    logger?.info(
                                        `[perf] revealInSchema cross-db-hit (${dbName}.${obj.SCHEMA}.${searchName}) ${(performance.now() - revealStart).toFixed(1)}ms`
                                    );
                                    emitRevealTelemetry('ok', {
                                        metadata: {
                                            path: 'cross_database',
                                            object_type: obj.OBJTYPE
                                        }
                                    });
                                    statusBarDisposable.dispose();
                                    vscode.window.setStatusBarMessage(
                                        `$(check) Found ${searchName} in ${dbName}.${obj.SCHEMA}`,
                                        3000
                                    );
                                    return;
                                }
                            } catch (e) {
                                logger?.warn(`[CQ01-REVEAL-004] Error searching object in ${dbName}`, e);
                            }
                        }
                    }
                }
                statusBarDisposable.dispose();
                vscode.window.showWarningMessage(`Could not find ${searchType || 'object'} ${searchName}`);
                emitRevealTelemetry('cancelled', { errorCode: 'OBJECT_NOT_FOUND' });
            } catch (err: unknown) {
                statusBarDisposable.dispose();
                const message = err instanceof Error ? err.message : String(err);
                logger?.error('[CQ01-REVEAL-005] Error revealing item', err);
                emitRevealTelemetry('error', { errorCode: 'CQ01-REVEAL-005' });
                vscode.window.showErrorMessage(
                    `Error revealing item (CQ01-REVEAL-005): ${formatRevealError(message, revealConnectionKind)}`,
                );
            }
        })
    ];
}
