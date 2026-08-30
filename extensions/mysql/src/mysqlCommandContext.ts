import * as vscode from 'vscode';
import type {
    ConnectionQueryResult,
    ConnectionSummary,
    JustyBaseLiteApi,
} from '../../../src/api/publicApi';
import type {
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget,
} from '@justybase/contracts';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

export interface MysqlSchemaItemData {
    label: string;
    dbName: string;
    schema: string;
    objType: string;
    connectionName?: string;
    rawLabel?: string;
}

export interface MysqlTableSchemaItemData extends MysqlSchemaItemData {
    objType: 'TABLE';
}

export function isTableItem(item: MysqlSchemaItemData | undefined): item is MysqlTableSchemaItemData {
    return !!item
        && !!item.label
        && !!item.dbName
        && !!item.schema
        && item.objType === 'TABLE';
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface MysqlMaintenanceApi {
    getConnectionSummary(connectionName: string): Promise<ConnectionSummary | undefined>;
    executeConnectionSql(sql: string, connectionName: string): Promise<void>;
    executeConnectionSqlQuery(sql: string, connectionName: string): Promise<ConnectionQueryResult>;
}

export function isMysqlMaintenanceApi(api: JustyBaseLiteApi): api is JustyBaseLiteApi & MysqlMaintenanceApi {
    return typeof api.getConnectionSummary === 'function'
        && typeof api.executeConnectionSql === 'function'
        && typeof api.executeConnectionSqlQuery === 'function';
}

function formatDuration(startTime: number): string {
    return ((Date.now() - startTime) / 1000).toFixed(1);
}

function queryResultToRows<T extends Record<string, unknown>>(result: ConnectionQueryResult): T[] {
    return result.rows.map(row => {
        const record: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
            record[column] = row[index];
        });
        return record as T;
    });
}

export function createMaintenanceServices(
    context: vscode.ExtensionContext,
    api: MysqlMaintenanceApi,
): DatabaseMaintenanceServices {
    return {
        context,
        async executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void> {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: progressTitle },
                async () => api.executeConnectionSql(sql, connectionName),
            );
        },
        async getConnectionDetails(): Promise<undefined> {
            return undefined;
        },
        async openSqlDocument(content: string, language = 'sql'): Promise<void> {
            const document = await vscode.workspace.openTextDocument({ content, language });
            await vscode.window.showTextDocument(document);
        },
        async executeWithProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
            return vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title },
                task,
            );
        },
        async executeAndReport(
            target: DatabaseMaintenanceTarget,
            sql: string,
            progressTitle: string,
            successMessage: string,
            errorPrefix: string,
        ): Promise<void> {
            try {
                const startTime = Date.now();
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: progressTitle },
                    async () => api.executeConnectionSql(sql, target.connectionName),
                );
                vscode.window.showInformationMessage(
                    `${successMessage} (${formatDuration(startTime)}s): ${target.qualifiedName}`,
                );
            } catch (error) {
                vscode.window.showErrorMessage(`${errorPrefix}: ${getErrorMessage(error)}`);
            }
        },
        async executeQuery<T extends Record<string, unknown>>(sql: string, connectionName: string): Promise<T[]> {
            return queryResultToRows<T>(await api.executeConnectionSqlQuery(sql, connectionName));
        },
    };
}

export interface MysqlDesignerOperationContext {
    target: DatabaseMaintenanceTarget;
    services: DatabaseMaintenanceServices;
}

export async function resolveOperationContext(
    context: vscode.ExtensionContext,
    api: MysqlMaintenanceApi,
    item: MysqlSchemaItemData,
    operationLabel: string,
): Promise<MysqlDesignerOperationContext | undefined> {
    const connectionName = item.connectionName?.trim();
    if (!connectionName) {
        vscode.window.showErrorMessage('The selected table is missing its database connection context. Refresh the schema tree and try again.');
        return undefined;
    }

    const connection = await api.getConnectionSummary(connectionName);
    if (!connection) {
        vscode.window.showErrorMessage(`Connection '${connectionName}' is no longer available. Select or reconnect it, then refresh the schema tree.`);
        return undefined;
    }

    if (connection.databaseKind.toLowerCase() !== 'mysql') {
        vscode.window.showErrorMessage(`${operationLabel} is only supported for MySQL connections.`);
        return undefined;
    }

    const tableName = item.rawLabel || item.label;
    return {
        target: {
            connectionName,
            databaseName: item.dbName,
            schemaName: item.schema,
            tableName,
            qualifiedName: formatQualifiedObjectName(undefined, item.schema, tableName, 'mysql'),
        },
        services: createMaintenanceServices(context, api),
    };
}
