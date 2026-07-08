import * as vscode from 'vscode';
import type {
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceServices,
  DatabaseMaintenanceTarget,
} from '@justybase/contracts';
import { getDatabaseMaintenanceProvider } from '../../../src/core/connectionFactory';
import { runQueryRaw, queryResultToRows } from '../../../src/core/singleQueryExecutor';
import { ConnectionManager } from '../../../src/core/connectionManager';

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

function formatDuration(startTime: number): string {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}

export function createMaintenanceServices(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager
): DatabaseMaintenanceServices {
  return {
    context,
    async executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void> {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: progressTitle },
        async () => {
          await runQueryRaw(context, sql, true, connectionManager, connectionName);
        }
      );
    },
    async getConnectionDetails(connectionName: string) {
      return connectionManager.getConnection(connectionName);
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
          await runQueryRaw(context, sql, true, connectionManager, target.connectionName);
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
    const result = await runQueryRaw(context, sql, true, connectionManager, connectionName);
    return queryResultToRows<T>(result);
  },
};
}

export function resolveOperationContext(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  item: TableSchemaItemData,
  operationLabel: string
): {
  provider: DatabaseMaintenanceProvider;
  target: DatabaseMaintenanceTarget;
  services: DatabaseMaintenanceServices;
} | undefined {
  const connectionName = connectionManager.resolveConnectionName(undefined, item.connectionName);
  if (!connectionName) {
    vscode.window.showErrorMessage('No database connection. Please connect first.');
    return undefined;
  }

  if (!connectionManager.supportsCapability('supportsTableMaintenance', undefined, connectionName)) {
    vscode.window.showErrorMessage(`${operationLabel} is not supported for the active database dialect.`);
    return undefined;
  }

  const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);

  if (databaseKind !== 'db2') {
    vscode.window.showErrorMessage(`${operationLabel} is only supported for Db2 connections.`);
    return undefined;
  }

  const provider = getDatabaseMaintenanceProvider(databaseKind);

  if (!provider) {
    vscode.window.showErrorMessage(`${operationLabel} is not supported for the active database dialect.`);
    return undefined;
  }

  const qualifiedName = `"${item.schema}"."${item.rawLabel || item.label}"`;

  return {
    provider,
    target: {
      connectionName,
      databaseName: item.dbName,
      schemaName: item.schema,
      tableName: item.rawLabel || item.label,
      qualifiedName,
    },
    services: createMaintenanceServices(context, connectionManager),
  };
}
