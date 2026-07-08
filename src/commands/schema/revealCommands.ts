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
        await schemaTreeView.reveal(targetItem, { select: true, focus: true });
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
                    const typeFilter =
                        searchType && searchType !== 'COLUMN' ? `AND UPPER(OBJTYPE) = UPPER('${searchType}')` : '';
                    const schemaFilter = normalizedSchema
                        ? `AND UPPER(SCHEMA) = UPPER('${normalizedSchema.replace(/'/g, "''").trim()}')`
                        : '';

                    const query = `
                        SELECT OBJNAME, OBJTYPE, SCHEMA, OBJID 
                        FROM ${targetDb}.._V_OBJECT_DATA 
                        WHERE UPPER(OBJNAME) = UPPER('${searchName.replace(/'/g, "''").trim()}') 
                        AND DBNAME = '${targetDb}'
                        ${typeFilter}
                        ${schemaFilter}
                        LIMIT 1
                    `;

                    try {
                        const objResult = await runQueryRaw(
                            context,
                            query,
                            true,
                            connectionManager,
                            targetConnectionName,
                            undefined, undefined, undefined, 1000000, false
                        );
                        if (objResult && objResult.data) {
                            const objects = queryResultToRows<{ OBJNAME: string; OBJTYPE: string; SCHEMA: string; OBJID: number }>(objResult);

                            if (objects.length > 0) {
                                const obj = objects[0];

                                if (obj.OBJTYPE === 'PROCEDURE') {
                                    try {
                                        const sigQuery = `SELECT PROCEDURESIGNATURE FROM ${targetDb}.._V_PROCEDURE WHERE OBJID = ${obj.OBJID}`;
                                        const sigResult = await runQueryRaw(
                                            context,
                                            sigQuery,
                                            true,
                                            connectionManager,
                                            targetConnectionName,
                                            undefined, undefined, undefined, 1000000, false
                                        );
                                        if (sigResult && sigResult.data && sigResult.data.length > 0) {
                                            const sigObj = queryResultToRows<{ PROCEDURESIGNATURE: string }>(sigResult);
                                            if (sigObj.length > 0 && sigObj[0].PROCEDURESIGNATURE) {
                                                obj.OBJNAME = sigObj[0].PROCEDURESIGNATURE;
                                            }
                                        }
                                    } catch (sigErr) {
                                        logger?.warn('[CQ01-REVEAL-002] Failed to resolve procedure signature', sigErr);
                                    }
                                }

                                const targetItem = new SchemaItem(
                                    obj.OBJNAME,
                                    vscode.TreeItemCollapsibleState.Collapsed,
                                    `netezza:${obj.OBJTYPE}`,
                                    targetDb,
                                    obj.OBJTYPE,
                                    obj.SCHEMA,
                                    obj.OBJID,
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
                    } catch (e) {
                        logger?.warn(`[CQ01-REVEAL-003] Error searching object in ${targetDb}`, e);
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
                                const typeFilter =
                                    searchType && searchType !== 'COLUMN' ? `AND UPPER(OBJTYPE) = UPPER('${searchType}')` : '';
                                const schemaFilter = normalizedSchema
                                    ? `AND UPPER(SCHEMA) = UPPER('${normalizedSchema.replace(/'/g, "''").trim()}')`
                                    : '';

                                const query = `
                                    SELECT OBJNAME, OBJTYPE, SCHEMA, OBJID 
                                    FROM ${dbName}.._V_OBJECT_DATA 
                                    WHERE UPPER(OBJNAME) = UPPER('${searchName.replace(/'/g, "''").trim()}') 
                                    AND DBNAME = '${dbName}'
                                    ${typeFilter}
                                    ${schemaFilter}
                                    LIMIT 1
                                `;

                                const objResultRaw = await runQueryRaw(
                                    context,
                                    query,
                                    true,
                                    connectionManager,
                                    targetConnectionName,
                                    undefined, undefined, undefined, 1000000, false
                                );
                                if (objResultRaw && objResultRaw.data) {
                                    const objects = queryResultToRows<{ OBJNAME: string; OBJTYPE: string; SCHEMA: string; OBJID: number }>(objResultRaw);

                                    if (objects.length > 0) {
                                        const obj = objects[0];

                                        if (obj.OBJTYPE === 'PROCEDURE') {
                                            try {
                                                const sigQuery = `SELECT PROCEDURESIGNATURE FROM ${dbName}.._V_PROCEDURE WHERE OBJID = ${obj.OBJID}`;
                                                const sigResult = await runQueryRaw(
                                                    context,
                                                    sigQuery,
                                                    true,
                                                    connectionManager,
                                                    targetConnectionName,
                                                    undefined, undefined, undefined, 1000000, false
                                                );
                                                if (sigResult && sigResult.data && sigResult.data.length > 0) {
                                                    const sigObj = queryResultToRows<{ PROCEDURESIGNATURE: string }>(sigResult);
                                                    if (sigObj.length > 0 && sigObj[0].PROCEDURESIGNATURE) {
                                                        obj.OBJNAME = sigObj[0].PROCEDURESIGNATURE;
                                                    }
                                                }
                                            } catch (sigErr) {
                                                logger?.warn('[CQ01-REVEAL-002] Failed to resolve procedure signature', sigErr);
                                            }
                                        }

                                        const targetItem = new SchemaItem(
                                            obj.OBJNAME,
                                            vscode.TreeItemCollapsibleState.Collapsed,
                                            `netezza:${obj.OBJTYPE}`,
                                            dbName,
                                            obj.OBJTYPE,
                                            obj.SCHEMA,
                                            obj.OBJID,
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
                vscode.window.showErrorMessage(`Error revealing item (CQ01-REVEAL-005): ${message}`);
            }
        })
    ];
}
