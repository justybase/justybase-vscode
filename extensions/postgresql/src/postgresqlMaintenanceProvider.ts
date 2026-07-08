import * as vscode from 'vscode';
import type {
  DatabaseMaintenanceProvider,
  DatabaseMaintenanceTarget,
  DatabaseMaintenanceServices,
  DatabasePartitionInfo,
  DatabaseCreatePartitionOptions,
  DatabaseAttachPartitionOptions,
  DatabaseIndexInfo,
  DatabaseCreateIndexOptions
} from '@justybase/contracts';
import {
  formatIdentifierForSql,
  formatQualifiedObjectName
} from '../../../src/utils/identifierUtils';
import {
  buildListPartitionsQuery,
  buildListIndexesQuery,
  buildIndexColumnsQuery
} from './postgresqlSystemQueries';

/**
 * Valid PostgreSQL partition strategies.
 */
const VALID_PARTITION_STRATEGIES = ['RANGE', 'LIST', 'HASH'] as const;
type PartitionStrategy = typeof VALID_PARTITION_STRATEGIES[number];

function formatPostgresqlIdentifier(identifier: string): string {
  return formatIdentifierForSql(identifier, 'postgresql');
}

function formatPostgresqlQualifiedName(schema: string, objectName: string): string {
  return formatQualifiedObjectName(undefined, schema, objectName, 'postgresql');
}

/**
 * Helper to format bytes into human-readable format.
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

/**
 * Row type for partition query results.
 */
interface PartitionRow {
  [key: string]: unknown;
  SCHEMA: string;
  NAME: string;
  PARENT_TABLE: string;
  PARTITION_BOUND: string;
  PARTITION_STRATEGY: string;
  ROW_COUNT: number;
  TOTAL_SIZE: number;
}

/**
 * Row type for index query results.
 */
interface IndexRow {
  [key: string]: unknown;
  SCHEMA: string;
  NAME: string;
  TABLE_NAME: string;
  TABLE_SCHEMA: string;
  INDEX_TYPE: string;
  IS_UNIQUE: boolean;
  IS_PRIMARY: boolean;
  DEFINITION: string;
  INDEX_SIZE: number;
  IS_VALID: boolean;
}

/**
 * Row type for index column query results.
 */
interface IndexColumnRow {
  [key: string]: unknown;
  COLUMN_NAME: string;
}

function getRowValue<T>(row: Record<string, unknown>, key: string): T | undefined {
  const direct = row[key];
  if (direct !== undefined) {
    return direct as T;
  }

  const lower = row[key.toLowerCase()];
  if (lower !== undefined) {
    return lower as T;
  }

  const upper = row[key.toUpperCase()];
  if (upper !== undefined) {
    return upper as T;
  }

  return undefined;
}

export const postgresqlMaintenanceProvider: DatabaseMaintenanceProvider = {
  async vacuumTable(target, services): Promise<void> {
    const qualifiedTable = formatPostgresqlQualifiedName(target.schemaName, target.tableName);
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'VACUUM', description: 'Standard PostgreSQL vacuum', sqlPrefix: 'VACUUM' },
        { label: 'VACUUM (FULL)', description: 'Rewrite table and reclaim more space', sqlPrefix: 'VACUUM (FULL)' },
        {
          label: 'VACUUM (ANALYZE)',
          description: 'Vacuum the table and refresh statistics in one pass',
          sqlPrefix: 'VACUUM (ANALYZE)',
        },
      ],
      {
        placeHolder: 'Select VACUUM mode',
      }
    );

    if (!mode) {
      return;
    }

    const sql = `${mode.sqlPrefix} ${qualifiedTable};`;
    const confirmation = await vscode.window.showWarningMessage(
      `Run ${mode.label} on table "${target.qualifiedName}"?\n\n${sql}\n\nWarning: PostgreSQL VACUUM options can hold stronger locks depending on the mode.`,
      { modal: true },
      'Yes, execute',
      'Cancel'
    );

    if (confirmation !== 'Yes, execute') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `${mode.label} ${target.qualifiedName}...`,
      `${mode.label} completed successfully`,
      `Error during ${mode.label}`
    );
  },

  async analyzeTable(target, services): Promise<void> {
    const qualifiedTable = formatPostgresqlQualifiedName(target.schemaName, target.tableName);
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'ANALYZE', description: 'Refresh planner statistics', sqlPrefix: 'ANALYZE' },
        {
          label: 'ANALYZE VERBOSE',
          description: 'Refresh planner statistics with verbose output',
          sqlPrefix: 'ANALYZE VERBOSE',
        },
      ],
      {
        placeHolder: 'Select ANALYZE mode',
      }
    );

    if (!mode) {
      return;
    }

    const sql = `${mode.sqlPrefix} ${qualifiedTable};`;
    const confirmation = await vscode.window.showInformationMessage(
      `Analyze table "${target.qualifiedName}"?\n\n${sql}`,
      { modal: true },
      'Yes, analyze',
      'Cancel'
    );

    if (confirmation !== 'Yes, analyze') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `${mode.label} ${target.qualifiedName}...`,
      'ANALYZE completed successfully',
      'Error during ANALYZE'
    );
  },

  async reindexTable(target, services): Promise<void> {
    const qualifiedTable = formatPostgresqlQualifiedName(target.schemaName, target.tableName);
    const sql = `REINDEX TABLE ${qualifiedTable};`;
    const confirmation = await vscode.window.showWarningMessage(
      `Reindex table "${target.qualifiedName}"?\n\n${sql}\n\nWarning: REINDEX can be disruptive on busy tables.`,
      { modal: true },
      'Yes, reindex',
      'Cancel'
    );

    if (confirmation !== 'Yes, reindex') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `REINDEX TABLE ${target.qualifiedName}...`,
      'REINDEX completed successfully',
      'Error during REINDEX'
    );
  },

  // =====================
  // PARTITION MANAGEMENT
  // =====================

  async listPartitions(
    target: DatabaseMaintenanceTarget,
  services: DatabaseMaintenanceServices
): Promise<DatabasePartitionInfo[]> {
  return services.executeWithProgress(
    `Listing partitions for ${target.tableName}...`,
    async () => {
      const rows = await services.executeQuery<PartitionRow>(
        buildListPartitionsQuery(target.schemaName, target.tableName),
        target.connectionName
      );

      return rows.map(row => {
        const strategy = getRowValue<string>(row, 'PARTITION_STRATEGY') || 'RANGE';
        return {
          schema: getRowValue<string>(row, 'SCHEMA') || target.schemaName,
          name: getRowValue<string>(row, 'NAME') || '',
          parentTable: getRowValue<string>(row, 'PARENT_TABLE') || target.tableName,
          partitionBound: getRowValue<string>(row, 'PARTITION_BOUND') || '',
          partitionStrategy: VALID_PARTITION_STRATEGIES.includes(strategy as PartitionStrategy)
            ? strategy as PartitionStrategy
            : 'RANGE',
          rowCount: getRowValue<number>(row, 'ROW_COUNT'),
          totalSize: getRowValue<number>(row, 'TOTAL_SIZE')
        };
      });
    }
  );
},

  async createPartition(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreatePartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void> {
    const schema = options.partitionSchema || target.schemaName;
    const qualifiedPartition = formatPostgresqlQualifiedName(schema, options.partitionName);
    const qualifiedParent = formatPostgresqlQualifiedName(target.schemaName, target.tableName);

    let sql = `CREATE TABLE ${qualifiedPartition} PARTITION OF ${qualifiedParent}`;

    if (options.isDefault) {
      sql += ` DEFAULT`;
    } else {
      sql += ` ${options.partitionBound}`;
    }

    if (options.tablespace) {
      sql += ` TABLESPACE ${formatPostgresqlIdentifier(options.tablespace)}`;
    }

    sql += `;`;

    const confirmation = await vscode.window.showWarningMessage(
      `Create partition "${options.partitionName}"?\n\n${sql}`,
      { modal: true },
      'Yes, create',
      'Cancel'
    );

    if (confirmation !== 'Yes, create') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Creating partition ${options.partitionName}...`,
      `Partition ${options.partitionName} created successfully`,
      `Error creating partition`
    );
  },

  async dropPartition(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    cascade = false,
    partitionSchema = target.schemaName
  ): Promise<void> {
    const qualifiedName = formatPostgresqlQualifiedName(partitionSchema, partitionName);
    const sql = `DROP TABLE ${qualifiedName}${cascade ? ' CASCADE' : ''};`;

    const confirmation = await vscode.window.showWarningMessage(
      `Drop partition "${partitionName}"?\n\nThis action cannot be undone.\n\n${sql}`,
      { modal: true },
      'Yes, drop',
      'Cancel'
    );

    if (confirmation !== 'Yes, drop') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Dropping partition ${partitionName}...`,
      `Partition ${partitionName} dropped successfully`,
      `Error dropping partition`
    );
  },

  async detachPartition(
    target: DatabaseMaintenanceTarget,
    partitionName: string,
    services: DatabaseMaintenanceServices,
    concurrently = false,
    partitionSchema = target.schemaName
  ): Promise<void> {
    const qualifiedParent = formatPostgresqlQualifiedName(target.schemaName, target.tableName);
    const qualifiedPartition = formatPostgresqlQualifiedName(partitionSchema, partitionName);

    let sql = `ALTER TABLE ${qualifiedParent} DETACH PARTITION ${qualifiedPartition}`;
    if (concurrently) {
      sql += ` CONCURRENTLY`;
    }
    sql += `;`;

    const confirmation = await vscode.window.showInformationMessage(
      `Detach partition "${partitionName}" from "${target.tableName}"?\n\nThe partition will become a standalone table.\n\n${sql}`,
      { modal: true },
      'Yes, detach',
      'Cancel'
    );

    if (confirmation !== 'Yes, detach') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Detaching partition ${partitionName}...`,
      `Partition ${partitionName} detached successfully`,
      `Error detaching partition`
    );
  },

  async attachPartition(
    target: DatabaseMaintenanceTarget,
    options: DatabaseAttachPartitionOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void> {
    const schema = options.schema || target.schemaName;
    const qualifiedParent = formatPostgresqlQualifiedName(target.schemaName, target.tableName);
    const qualifiedTable = formatPostgresqlQualifiedName(schema, options.tableName);

    const sql = `ALTER TABLE ${qualifiedParent} ATTACH PARTITION ${qualifiedTable} ${options.partitionBound};`;

    const confirmation = await vscode.window.showWarningMessage(
      `Attach table "${options.tableName}" as partition of "${target.tableName}"?\n\n${sql}`,
      { modal: true },
      'Yes, attach',
      'Cancel'
    );

    if (confirmation !== 'Yes, attach') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Attaching partition ${options.tableName}...`,
      `Partition ${options.tableName} attached successfully`,
      `Error attaching partition`
    );
  },

  // =====================
  // INDEX MANAGEMENT
  // =====================

  async listIndexes(
  target: DatabaseMaintenanceTarget,
  services: DatabaseMaintenanceServices
): Promise<DatabaseIndexInfo[]> {
  return services.executeWithProgress(
    `Listing indexes for ${target.tableName}...`,
    async () => {
      const rows = await services.executeQuery<IndexRow>(
        buildListIndexesQuery(target.schemaName, target.tableName),
        target.connectionName
      );

      const indexes: DatabaseIndexInfo[] = [];

      for (const row of rows) {
        const indexSchema = getRowValue<string>(row, 'SCHEMA') || target.schemaName;
        const indexName = getRowValue<string>(row, 'NAME') || '';
        const columnRows = await services.executeQuery<IndexColumnRow>(
          buildIndexColumnsQuery(indexSchema, indexName),
          target.connectionName
        );

        indexes.push({
          schema: indexSchema,
          name: indexName,
          tableName: getRowValue<string>(row, 'TABLE_NAME') || target.tableName,
          tableSchema: getRowValue<string>(row, 'TABLE_SCHEMA') || target.schemaName,
          indexType: getRowValue<string>(row, 'INDEX_TYPE') || 'btree',
          isUnique: Boolean(getRowValue<boolean>(row, 'IS_UNIQUE')),
          isPrimary: Boolean(getRowValue<boolean>(row, 'IS_PRIMARY')),
          columns: columnRows
            .map(columnRow => getRowValue<string>(columnRow, 'COLUMN_NAME'))
            .filter((columnName): columnName is string => typeof columnName === 'string' && columnName.length > 0),
          definition: getRowValue<string>(row, 'DEFINITION'),
          indexSize: getRowValue<number>(row, 'INDEX_SIZE'),
          isValid: getRowValue<boolean>(row, 'IS_VALID')
        });
      }
      return indexes;
    }
  );
},

  async createIndex(
    target: DatabaseMaintenanceTarget,
    options: DatabaseCreateIndexOptions,
    services: DatabaseMaintenanceServices
  ): Promise<void> {
    const indexName = options.indexName || `${target.tableName}_${options.columns.join('_')}_idx`;
    const formattedIndexName = formatPostgresqlIdentifier(indexName);
    const qualifiedTable = formatPostgresqlQualifiedName(target.schemaName, target.tableName);

    const parts: string[] = [];

    if (options.concurrent) {
      parts.push('CONCURRENTLY');
    }

    if (options.ifNotExists) {
      parts.push('IF NOT EXISTS');
    }

    parts.push(formattedIndexName);

    parts.push(`ON ${qualifiedTable}`);

    if (options.indexType && options.indexType !== 'btree') {
      parts.push(`USING ${options.indexType}`);
    }

    const columnList = options.columns.map(c => formatPostgresqlIdentifier(c)).join(', ');
    parts.push(`(${columnList})`);

    if (options.includeColumns && options.includeColumns.length > 0) {
      const includeList = options.includeColumns.map(c => formatPostgresqlIdentifier(c)).join(', ');
      parts.push(`INCLUDE (${includeList})`);
    }

    if (options.whereClause) {
      parts.push(`WHERE ${options.whereClause}`);
    }

    if (options.tablespace) {
      parts.push(`TABLESPACE ${formatPostgresqlIdentifier(options.tablespace)}`);
    }

    const sql = `CREATE ${options.isUnique ? 'UNIQUE ' : ''}INDEX ${parts.join(' ')};`;

    const confirmation = await vscode.window.showInformationMessage(
      `Create index "${indexName}" on "${target.tableName}"?\n\n${sql}`,
      { modal: true },
      'Yes, create',
      'Cancel'
    );

    if (confirmation !== 'Yes, create') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Creating index ${indexName}...`,
      `Index ${indexName} created successfully`,
      `Error creating index`
    );
  },

  async dropIndex(
    target: DatabaseMaintenanceTarget,
    indexName: string,
    services: DatabaseMaintenanceServices,
    cascade = false,
    concurrently = false
  ): Promise<void> {
    const qualifiedIndex = formatPostgresqlQualifiedName(target.schemaName, indexName);

    let sql = `DROP INDEX`;
    if (concurrently) {
      sql += ` CONCURRENTLY`;
    }
    sql += ` ${qualifiedIndex}`;
    if (cascade) {
      sql += ` CASCADE`;
    }
    sql += `;`;

    const confirmation = await vscode.window.showWarningMessage(
      `Drop index "${indexName}"?\n\nThis action cannot be undone.\n\n${sql}`,
      { modal: true },
      'Yes, drop',
      'Cancel'
    );

    if (confirmation !== 'Yes, drop') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Dropping index ${indexName}...`,
      `Index ${indexName} dropped successfully`,
      `Error dropping index`
    );
  },

  async reindexIndex(
    target: DatabaseMaintenanceTarget,
    indexName: string,
    options: { concurrently?: boolean; verbose?: boolean; tablespace?: string },
    services: DatabaseMaintenanceServices,
    indexSchema = target.schemaName
  ): Promise<void> {
    const qualifiedIndex = formatPostgresqlQualifiedName(indexSchema, indexName);

    const parts: string[] = [];
    if (options.concurrently) {
      parts.push('CONCURRENTLY');
    }
    if (options.verbose) {
      parts.push('VERBOSE');
    }
    if (options.tablespace) {
      parts.push(`TABLESPACE ${formatPostgresqlIdentifier(options.tablespace)}`);
    }

    let sql = 'REINDEX INDEX';
    if (parts.length > 0) {
      sql += ` (${parts.join(', ')})`;
    }
    sql += ` ${qualifiedIndex};`;

    const confirmation = await vscode.window.showWarningMessage(
      `Reindex index "${indexName}"?\n\nWarning: REINDEX can be disruptive on busy tables.\n\n${sql}`,
      { modal: true },
      'Yes, reindex',
      'Cancel'
    );

    if (confirmation !== 'Yes, reindex') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Reindexing index ${indexName}...`,
      `Index ${indexName} reindexed successfully`,
      'Error during REINDEX'
    );
  },

  async reindexWithOptions(
    target: DatabaseMaintenanceTarget,
    options: { concurrently?: boolean; verbose?: boolean; tablespace?: string },
    services: DatabaseMaintenanceServices
  ): Promise<void> {
    const qualifiedTable = formatPostgresqlQualifiedName(target.schemaName, target.tableName);

    const parts: string[] = [];
    if (options.concurrently) {
      parts.push('CONCURRENTLY');
    }
    if (options.verbose) {
      parts.push('VERBOSE');
    }
    if (options.tablespace) {
      parts.push(`TABLESPACE ${formatPostgresqlIdentifier(options.tablespace)}`);
    }

    let sql = `REINDEX TABLE`;
    if (parts.length > 0) {
      sql += ` (${parts.join(', ')})`;
    }
    sql += ` ${qualifiedTable}`;
    sql += `;`;

    const confirmation = await vscode.window.showWarningMessage(
      `Reindex table "${target.tableName}"?\n\nWarning: REINDEX can be disruptive on busy tables.\n\n${sql}`,
      { modal: true },
      'Yes, reindex',
      'Cancel'
    );

    if (confirmation !== 'Yes, reindex') {
      return;
    }

    await services.executeAndReport(
      target,
      sql,
      `Reindexing ${target.tableName}...`,
      'REINDEX completed successfully',
      'Error during REINDEX'
    );
  },
};

export { formatBytes };
