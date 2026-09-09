import type { ExtensionContext } from 'vscode';
import type {
  ConnectionDetails,
  DatabaseSessionMonitorServices,
} from '@justybase/contracts';
import { createConnectedDatabaseConnectionFromDetails } from './connectionFactory';
import type { ConnectionManager } from './connectionManager';
import { queryResultToRows, runQueryRaw } from './queryRunner';
import type { NzConnection } from './nzConnectionFactory';

export {
  emptySessionMonitorResources,
  escapeSqlLiteral,
  executeSessionMonitorStatement,
  normalizeDatabaseFilter,
  runSessionMonitorQuery,
  toNumber,
  validatePositiveIntegerSessionId,
} from '@justybase/database-utils/sessionMonitorProviderUtils';
export type { SessionMonitorResources } from '@justybase/database-utils/sessionMonitorProviderUtils';

async function executeQueryRows(
  connection: NzConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const command = connection.createCommand(sql);
  command.commandTimeout = 90;
  const reader = await command.executeReader();
  const rows: Record<string, unknown>[] = [];

  try {
    while (await reader.read()) {
      const row: Record<string, unknown> = {};
      for (let index = 0; index < reader.fieldCount; index++) {
        row[reader.getName(index)] = reader.getValue(index);
      }
      rows.push(row);
    }
    return rows;
  } finally {
    await reader.close();
  }
}

/**
 * Adapts the desktop query runner to the platform-neutral session-monitor port.
 * Companion extensions receive only this port and never the desktop manager.
 */
export function createSessionMonitorServices(
  context: ExtensionContext,
  connectionManager: ConnectionManager,
): DatabaseSessionMonitorServices {
  const query = async <T extends Record<string, unknown>>(
    sql: string,
    rowLimit = 1000,
    connectionName?: string,
  ): Promise<T[]> => {
    const result = await runQueryRaw(
      context,
      sql,
      true,
      connectionManager,
      connectionName,
      undefined,
      undefined,
      undefined,
      rowLimit,
      false,
    );
    return result?.data ? queryResultToRows<T>(result) : [];
  };

  const execute = async (
    sql: string,
    connectionName?: string,
  ): Promise<void> => {
    await runQueryRaw(
      context,
      sql,
      true,
      connectionManager,
      connectionName,
      undefined,
      undefined,
      undefined,
      1,
      false,
    );
  };

  const getConnectionDetails = async (
    connectionName?: string,
  ): Promise<ConnectionDetails | undefined> => {
    const targetName = connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
    return targetName ? connectionManager.getConnection(targetName) : undefined;
  };

  const queryDatabase = async <T extends Record<string, unknown>>(
    database: string,
    sql: string,
    connectionName?: string,
  ): Promise<T[]> => {
    const details = await getConnectionDetails(connectionName);
    if (!details) {
      return [];
    }

    const connection = await createConnectedDatabaseConnectionFromDetails({
      ...details,
      database,
    }) as NzConnection;
    try {
      return await executeQueryRows(connection, sql) as T[];
    } finally {
      try {
        await connection.close();
      } catch {
        // The query result is already available; cleanup failures are non-fatal here.
      }
    }
  };

  return { query, execute, getConnectionDetails, queryDatabase };
}
