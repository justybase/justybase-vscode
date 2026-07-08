/**
 * Schema Commands - Maintenance Operations
 */

import * as vscode from 'vscode';
import type {
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceServices,
  DatabaseMaintenanceTarget,
} from '../../contracts/database';
import { getDatabaseMaintenanceProvider } from '../../core/connectionFactory';
import { runQuery, runQueryRaw, queryResultToRows } from '../../core/queryRunner';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName, executeWithProgress } from './helpers';

type MaintenanceOperation =
  | 'groomTable'
  | 'generateStatistics'
  | 'checkSkew'
  | 'recreateTable'
  | 'vacuumTable'
  | 'analyzeTable'
  | 'reindexTable'
  | 'listPartitions'
  | 'createPartition'
  | 'dropPartition'
  | 'detachPartition'
  | 'attachPartition'
  | 'listIndexes'
  | 'createIndex'
  | 'dropIndex'
  | 'reindexWithOptions';

type TableSchemaItemData = SchemaItemData & {
    label: string;
    dbName: string;
    schema: string;
    objType: 'TABLE';
};

function isTableItem(item: SchemaItemData | undefined): item is TableSchemaItemData {
    return !!item && !!item.label && !!item.dbName && !!item.schema && item.objType === 'TABLE';
}

function formatDuration(startTime: number): string {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseCommaSeparatedIdentifiers(input: string): { values: string[]; hasEmptyEntry: boolean } {
  const segments = input.split(',');
  const values: string[] = [];
  let hasEmptyEntry = false;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      hasEmptyEntry = true;
      continue;
    }
    values.push(trimmed);
  }

  return { values, hasEmptyEntry };
}

/**
 * Format bytes into human-readable format.
 */
function formatBytes(bytes?: number): string {
  if (!bytes) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(2)} ${units[i]}`;
}

function createMaintenanceServices(deps: SchemaCommandsDependencies): DatabaseMaintenanceServices {
  return {
    context: deps.context,
    async executeSql(sql: string, connectionName: string, progressTitle: string): Promise<void> {
      await executeWithProgress(progressTitle, async () => {
        await runQuery(deps.context, sql, true, connectionName, deps.connectionManager);
      });
    },
    async getConnectionDetails(connectionName: string) {
      return deps.connectionManager.getConnection(connectionName);
    },
    async openSqlDocument(content: string, language = 'sql'): Promise<void> {
      const document = await vscode.workspace.openTextDocument({
        content,
        language,
      });
      await vscode.window.showTextDocument(document);
    },
    async executeWithProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
      return executeWithProgress(title, task);
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
        await executeWithProgress(progressTitle, async () => {
          await runQuery(deps.context, sql, true, target.connectionName, deps.connectionManager);
        });
        vscode.window.showInformationMessage(
          `${successMessage} (${formatDuration(startTime)}s): ${target.qualifiedName}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`${errorPrefix}: ${getErrorMessage(error)}`);
      }
    },
    async executeQuery<T extends Record<string, unknown>>(sql: string, connectionName: string): Promise<T[]> {
      const result = await runQueryRaw(deps.context, sql, true, deps.connectionManager, connectionName);
      return queryResultToRows<T>(result);
    },
  };
}

function resolveOperationContext(
    deps: SchemaCommandsDependencies,
    item: TableSchemaItemData,
    operationLabel: string
): {
    provider: DatabaseMaintenanceProvider;
    target: DatabaseMaintenanceTarget;
    services: DatabaseMaintenanceServices;
} | undefined {
    const connectionName = deps.connectionManager.resolveConnectionName(undefined, item.connectionName);
    if (!connectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return undefined;
    }

    if (!deps.connectionManager.supportsCapability('supportsTableMaintenance', undefined, connectionName)) {
        vscode.window.showErrorMessage(`${operationLabel} is not supported for the active database dialect.`);
        return undefined;
    }

    const databaseKind = deps.connectionManager.getConnectionDatabaseKind(connectionName);

    const provider = getDatabaseMaintenanceProvider(databaseKind);

    if (!provider) {
        vscode.window.showErrorMessage(`${operationLabel} is not supported for the active database dialect.`);
        return undefined;
    }

    const qualifiedName = getFullName({ ...item, connectionName }, deps.connectionManager);

    return {
        provider,
        target: {
            connectionName,
            databaseName: item.dbName,
            schemaName: item.schema,
            tableName: item.rawLabel || item.label,
            qualifiedName,
        },
        services: createMaintenanceServices(deps),
    };
}

async function invokeMaintenanceOperation(
    deps: SchemaCommandsDependencies,
    item: TableSchemaItemData,
    operation: MaintenanceOperation,
    operationLabel: string
): Promise<void> {
    const resolved = resolveOperationContext(deps, item, operationLabel);
    if (!resolved) {
        return;
    }

    const handler = resolved.provider[operation] as
        | ((target: DatabaseMaintenanceTarget, services: DatabaseMaintenanceServices) => Promise<void>)
        | undefined;
    if (!handler) {
        vscode.window.showErrorMessage(`${operationLabel} is not supported for the active database dialect.`);
        return;
    }

    await handler(resolved.target, resolved.services);
}

/**
 * Register maintenance commands
 */
export function registerMaintenanceCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.groomTable', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'groomTable', 'Table maintenance');
        }),

        vscode.commands.registerCommand('netezza.generateStatistics', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'generateStatistics', 'Statistics generation');
        }),

        vscode.commands.registerCommand('netezza.checkSkew', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'checkSkew', 'Skew check');
        }),

        vscode.commands.registerCommand('netezza.recreateTable', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Invalid object selected for Recreate Table');
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'recreateTable', 'Table recreation');
        }),

        vscode.commands.registerCommand('netezza.vacuumTable', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'vacuumTable', 'Table maintenance');
        }),

        vscode.commands.registerCommand('netezza.analyzeTable', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                return;
            }

            await invokeMaintenanceOperation(deps, item, 'analyzeTable', 'Statistics generation');
        }),

  vscode.commands.registerCommand('netezza.reindexTable', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      return;
    }

    await invokeMaintenanceOperation(deps, item, 'reindexTable', 'Index maintenance');
  }),

  // =====================
  // POSTGRESQL PARTITION COMMANDS
  // =====================

  vscode.commands.registerCommand('postgresql.listPartitions', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      vscode.window.showErrorMessage('Please select a table to list partitions.');
      return;
    }

    const resolved = resolveOperationContext(deps, item, 'List partitions');
    if (!resolved) {
      return;
    }

    try {
      const partitions = await resolved.provider.listPartitions?.(resolved.target, resolved.services);

      if (!partitions || partitions.length === 0) {
        vscode.window.showInformationMessage('No partitions found for this table.');
        return;
      }

      const items = partitions.map(p => ({
        label: p.name,
        description: p.partitionBound,
        detail: `Rows: ${p.rowCount?.toLocaleString() ?? 'N/A'}, Size: ${formatBytes(p.totalSize)}`,
        partition: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a partition for actions',
      });

      if (selected) {
        const action = await vscode.window.showQuickPick(
          [
            { label: '$(trash) Drop Partition', action: 'drop' },
            { label: '$(debug-disconnect) Detach Partition', action: 'detach' },
            { label: '$(copy) Copy DDL', action: 'copy' },
          ],
          { placeHolder: `Actions for partition "${selected.label}"` }
        );

        if (action?.action === 'drop') {
          const cascade = await vscode.window.showQuickPick(
            [
              { label: 'No', value: false },
              { label: 'Yes', value: true },
            ],
            { placeHolder: 'Drop cascade?' }
          );
          await resolved.provider.dropPartition?.(
            resolved.target,
            selected.label,
            resolved.services,
            cascade?.value,
            selected.partition.schema
          );
        } else if (action?.action === 'detach') {
          const concurrently = await vscode.window.showQuickPick(
            [
              { label: 'No', value: false },
              { label: 'Yes (PostgreSQL 12+)', value: true },
            ],
            { placeHolder: 'Detach concurrently?' }
          );
          await resolved.provider.detachPartition?.(
            resolved.target,
            selected.label,
            resolved.services,
            concurrently?.value,
            selected.partition.schema
          );
        } else if (action?.action === 'copy') {
          const ddl = `CREATE TABLE "${selected.partition.schema}"."${selected.label}" PARTITION OF "${resolved.target.schemaName}"."${resolved.target.tableName}" ${selected.partition.partitionBound};`;
          await vscode.env.clipboard.writeText(ddl);
          vscode.window.showInformationMessage('Partition DDL copied to clipboard.');
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to list partitions: ${getErrorMessage(error)}`);
    }
  }),

  vscode.commands.registerCommand('postgresql.createPartition', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      vscode.window.showErrorMessage('Please select a partitioned table.');
      return;
    }

    const resolved = resolveOperationContext(deps, item, 'Create partition');
    if (!resolved) {
      return;
    }

    const partitionNameInput = await vscode.window.showInputBox({
      prompt: 'Enter partition name',
      placeHolder: 'e.g., orders_2024_01',
    });

    if (!partitionNameInput) {
      return;
    }

    const partitionName = trimToUndefined(partitionNameInput);
    if (!partitionName) {
      vscode.window.showErrorMessage('Partition name cannot be empty.');
      return;
    }

    const partitionType = await vscode.window.showQuickPick(
      [
        { label: 'RANGE', description: 'For date/numeric ranges' },
        { label: 'LIST', description: 'For discrete values' },
        { label: 'DEFAULT', description: 'Catch-all partition' },
      ],
      { placeHolder: 'Select partition type' }
    );

    if (!partitionType) {
      return;
    }

    let partitionBound: string;
    let isDefault = false;

    if (partitionType.label === 'DEFAULT') {
      isDefault = true;
      partitionBound = 'DEFAULT';
    } else {
      const boundValueInput = await vscode.window.showInputBox({
        prompt: `Enter ${partitionType.label} bound`,
        placeHolder:
          partitionType.label === 'RANGE'
            ? "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')"
            : "FOR VALUES IN ('value1', 'value2')",
      });
      if (!boundValueInput) {
        return;
      }
      const boundValue = trimToUndefined(boundValueInput);
      if (!boundValue) {
        vscode.window.showErrorMessage('Partition bound cannot be empty.');
        return;
      }
      partitionBound = boundValue;
    }

    await resolved.provider.createPartition?.(
      resolved.target,
      { partitionName, partitionBound, isDefault },
      resolved.services
    );
  }),

  vscode.commands.registerCommand('postgresql.attachPartition', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      vscode.window.showErrorMessage('Please select a partitioned table.');
      return;
    }

    const resolved = resolveOperationContext(deps, item, 'Attach partition');
    if (!resolved) {
      return;
    }

    const tableName = await vscode.window.showInputBox({
      prompt: 'Enter the name of the table to attach',
      placeHolder: 'e.g., orders_archive_2024',
    });

    if (!tableName) {
      return;
    }

    const partitionBound = await vscode.window.showInputBox({
      prompt: 'Enter partition bound expression',
      placeHolder: "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')",
    });

    if (!partitionBound) {
      return;
    }

    await resolved.provider.attachPartition?.(
      resolved.target,
      { tableName, partitionBound },
      resolved.services
    );
  }),

  // =====================
  // POSTGRESQL INDEX COMMANDS
  // =====================

  vscode.commands.registerCommand('postgresql.listIndexes', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      vscode.window.showErrorMessage('Please select a table to list indexes.');
      return;
    }

    const resolved = resolveOperationContext(deps, item, 'List indexes');
    if (!resolved) {
      return;
    }

    try {
      const indexes = await resolved.provider.listIndexes?.(resolved.target, resolved.services);

      if (!indexes || indexes.length === 0) {
        vscode.window.showInformationMessage('No indexes found for this table.');
        return;
      }

      const items = indexes.map(idx => ({
        label: idx.name,
        description: idx.indexType + (idx.isUnique ? ' (UNIQUE)' : '') + (idx.isPrimary ? ' (PRIMARY)' : ''),
        detail: `Columns: ${idx.columns.join(', ')} | Size: ${formatBytes(idx.indexSize)}${idx.isValid === false ? ' | INVALID' : ''}`,
        index: idx,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an index for actions',
      });

      if (selected) {
        const action = await vscode.window.showQuickPick(
          [
            { label: '$(trash) Drop Index', action: 'drop' },
            { label: '$(refresh) Reindex', action: 'reindex' },
            { label: '$(copy) Copy DDL', action: 'copy' },
          ],
          { placeHolder: `Actions for index "${selected.label}"` }
        );

        if (action?.action === 'drop') {
          const concurrently = await vscode.window.showQuickPick(
            [
              { label: 'No', value: false },
              { label: 'Yes', value: true },
            ],
            { placeHolder: 'Drop concurrently?' }
          );
          const cascade = await vscode.window.showQuickPick(
            [
              { label: 'No', value: false },
              { label: 'Yes', value: true },
            ],
            { placeHolder: 'Drop cascade?' }
          );
          await resolved.provider.dropIndex?.(
            resolved.target,
            selected.label,
            resolved.services,
            cascade?.value,
            concurrently?.value
          );
        } else if (action?.action === 'reindex') {
          const reindexConcurrently = await vscode.window.showQuickPick(
            [
              { label: 'No', value: false },
              { label: 'Yes', value: true },
            ],
            { placeHolder: 'Reindex concurrently?' }
          );

          if (!resolved.provider.reindexIndex) {
            vscode.window.showErrorMessage('Index reindex is not supported for the active database dialect.');
            return;
          }

          await resolved.provider.reindexIndex?.(
            resolved.target,
            selected.label,
            { concurrently: reindexConcurrently?.value ?? false },
            resolved.services,
            selected.index.schema
          );
        } else if (action?.action === 'copy') {
          const definition = selected.index.definition;
          if (!definition) {
            vscode.window.showWarningMessage('Index DDL definition is not available.');
            return;
          }
          await vscode.env.clipboard.writeText(definition);
          vscode.window.showInformationMessage('Index DDL copied to clipboard.');
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to list indexes: ${getErrorMessage(error)}`);
    }
  }),

  vscode.commands.registerCommand('postgresql.createIndex', async (item: SchemaItemData) => {
    if (!isTableItem(item)) {
      vscode.window.showErrorMessage('Please select a table to create an index.');
      return;
    }

    const resolved = resolveOperationContext(deps, item, 'Create index');
    if (!resolved) {
      return;
    }

    const columnsInput = await vscode.window.showInputBox({
      prompt: 'Enter column names (comma-separated)',
      placeHolder: 'e.g., created_at, user_id',
    });

    if (!columnsInput) {
      return;
    }

    const parsedColumns = parseCommaSeparatedIdentifiers(columnsInput);
    if (parsedColumns.values.length === 0) {
      vscode.window.showErrorMessage('Enter at least one column name.');
      return;
    }
    if (parsedColumns.hasEmptyEntry) {
      vscode.window.showErrorMessage('Column list contains an empty entry. Remove extra commas and try again.');
      return;
    }

    const columns = parsedColumns.values;

    const indexType = await vscode.window.showQuickPick(
      [
        { label: 'btree', description: 'Default B-tree index' },
        { label: 'hash', description: 'Hash index' },
        { label: 'gist', description: 'GiST index' },
        { label: 'gin', description: 'GIN index' },
        { label: 'spgist', description: 'SP-GiST index' },
        { label: 'brin', description: 'BRIN index' },
      ],
      { placeHolder: 'Select index type' }
    );

    const isUnique = await vscode.window.showQuickPick(
      [
        { label: 'No', value: false },
        { label: 'Yes', value: true },
      ],
      { placeHolder: 'Create unique index?' }
    );

    const whereClauseInput = await vscode.window.showInputBox({
      prompt: 'Enter WHERE clause for partial index (optional)',
      placeHolder: 'e.g., status = \'active\'',
    });

    const whereClause = trimToUndefined(whereClauseInput);

    await resolved.provider.createIndex?.(
      resolved.target,
      {
        columns,
        indexType: indexType?.label as 'btree' | 'hash' | 'gist' | 'gin' | 'spgist' | 'brin' | undefined,
        isUnique: isUnique?.value,
        whereClause,
      },
      resolved.services
    );
  }),
  ];
}
