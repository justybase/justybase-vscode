import * as vscode from 'vscode';
import type {
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceServices,
  DatabaseMaintenanceTarget,
} from '@justybase/contracts';
import type {
  ConnectionQueryResult,
  ConnectionSummary,
  JustyBaseLiteApi
} from '../../../src/api/publicApi';
import { db2MaintenanceProvider } from './db2MaintenanceProvider';

export interface SchemaItemData {
  label: string;
  dbName: string;
  schema: string;
  objType: string;
  connectionName?: string;
  rawLabel?: string;
}

export interface TableSchemaItemData extends SchemaItemData {
  label: string;
  dbName: string;
  schema: string;
  objType: 'TABLE' | 'ALIAS' | 'VIEW';
}

export function isTableItem(item: SchemaItemData | undefined): item is TableSchemaItemData {
  return !!item && !!item.label && !!item.dbName && !!item.schema && (item.objType === 'TABLE' || item.objType === 'ALIAS');
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Db2MaintenanceApi {
  getConnectionSummary(connectionName: string): Promise<ConnectionSummary | undefined>;
  executeConnectionSql(sql: string, connectionName: string): Promise<void>;
  executeConnectionSqlQuery(sql: string, connectionName: string): Promise<ConnectionQueryResult>;
}

export function isDb2MaintenanceApi(api: JustyBaseLiteApi): api is JustyBaseLiteApi & Db2MaintenanceApi {
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
  api: Db2MaintenanceApi
): DatabaseMaintenanceServices {
  return {
    context,
    async executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void> {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: progressTitle },
        async () => {
          await api.executeConnectionSql(sql, connectionName);
        }
      );
    },
    async getConnectionDetails(_connectionName: string) {
      // Credentials remain private to the core extension. Db2 recreate-table
      // is available through the core maintenance command instead.
      return undefined;
    },
    async openSqlDocument(content: string, language = 'sql'): Promise<void> {
      const document = await vscode.workspace.openTextDocument({
        content,
        language,
      });
      await vscode.window.showTextDocument(document);
    },
    async executeWithProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        task
      );
    },
  async executeAndReport(
    target: DatabaseMaintenanceTarget,
    sql: string,
    progressTitle: string,
    successMessage: string,
    errorPrefix: string
  ): Promise<void> {
    try {
      const startTime = Date.now();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: progressTitle },
        async () => {
          await api.executeConnectionSql(sql, target.connectionName);
        }
      );
      vscode.window.showInformationMessage(
        `${successMessage} (${formatDuration(startTime)}s): ${target.qualifiedName}`
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

export async function resolveOperationContext(
  context: vscode.ExtensionContext,
  api: Db2MaintenanceApi,
  item: TableSchemaItemData,
  operationLabel: string
): Promise<{
  provider: DatabaseMaintenanceProvider;
  target: DatabaseMaintenanceTarget;
  services: DatabaseMaintenanceServices;
} | undefined> {
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

  if (connection.databaseKind.toLowerCase() !== 'db2') {
    vscode.window.showErrorMessage(`${operationLabel} is only supported for Db2 connections.`);
    return undefined;
  }

  const qualifiedName = `"${item.schema}"."${item.rawLabel || item.label}"`;

  return {
    // Companion bundles have their own module graph, so use the concrete Db2
    // provider instead of looking it up in the core extension's registry.
    provider: db2MaintenanceProvider,
    target: {
      connectionName,
      databaseName: item.dbName,
      schemaName: item.schema,
      tableName: item.rawLabel || item.label,
      qualifiedName,
    },
    services: createMaintenanceServices(context, api),
  };
}
