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
  openRecreateTableScript,
  quoteSqlLiteral
} from '../../../src/core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import {
  buildListPartitionsQuery,
  buildListIndexesDetailedQuery,
  buildIndexColumnsDetailedQuery
} from './db2SystemQueries';

function getDb2QualifiedTableName(target: Parameters<NonNullable<DatabaseMaintenanceProvider['generateStatistics']>>[0]): string {
    return formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'db2');
}

/**
 * Row type for partition query results in DB2.
 */
interface Db2PartitionRow {
    [key: string]: unknown;
    PARTITION_NAME: string;
    PARTITION_SEQNO: number;
    LOWVALUE: string;
    HIGHVALUE: string;
    LOWINCLUSIVE: string;
    HIGHINCLUSIVE: string;
    TBSPACE: string;
    ROW_COUNT: number;
    NPAGES: number;
    FPAGES: number;
    PARENT_TABLE: string;
}

/**
 * Row type for index query results in DB2.
 */
interface Db2IndexRow {
    [key: string]: unknown;
    INDEX_SCHEMA: string;
    INDEX_NAME: string;
    TABLE_SCHEMA: string;
    TABLE_NAME: string;
    UNIQUERULE: string;
    INDEXTYPE: string;
    COMPRESSION: string;
    NLEAF: number;
    NLEVELS: number;
    FULLKEYCARD: number;
    FIRSTKEYCARD: number;
    FIRST2KEYCARD: number;
    PCTFREE: string;
    REMARKS: string;
    SYSTEM_REQUIRED: number;
    TBSPACE: string;
}

/**
 * Row type for index columns in DB2.
 */
interface Db2IndexColumnRow {
    [key: string]: unknown;
    COLNAME: string;
    COLSEQ: number;
    COLORDER: string;
}

export const db2MaintenanceProvider: DatabaseMaintenanceProvider = {
    async generateStatistics(target, services): Promise<void> {
        const commandText = `RUNSTATS ON TABLE ${getDb2QualifiedTableName(target)} ON ALL COLUMNS AND DETAILED INDEXES ALL`;
        const sql = `CALL SYSPROC.ADMIN_CMD(${quoteSqlLiteral(commandText)});`;
        const confirmation = await vscode.window.showInformationMessage(
            `Generate statistics for table "${target.qualifiedName}"?\n\n${commandText}`,
            { modal: true },
            'Yes, generate',
            'Cancel'
        );

        if (confirmation !== 'Yes, generate') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `RUNSTATS ${target.qualifiedName}...`,
            'RUNSTATS completed successfully',
            'Error during RUNSTATS'
        );
    },

    async vacuumTable(target, services): Promise<void> {
        const commandText = `REORG TABLE ${getDb2QualifiedTableName(target)} ALLOW WRITE ACCESS`;
        const sql = `CALL SYSPROC.ADMIN_CMD(${quoteSqlLiteral(commandText)});`;
        const confirmation = await vscode.window.showWarningMessage(
            `Reorganize table "${target.qualifiedName}" to reclaim space?\n\n${commandText}`,
            { modal: true },
            'Yes, reorganize',
            'Cancel'
        );

        if (confirmation !== 'Yes, reorganize') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `REORG TABLE ${target.qualifiedName}...`,
            'REORG TABLE completed successfully',
            'Error during REORG TABLE'
        );
    },

    async reindexTable(target, services): Promise<void> {
        const commandText = `REORG INDEXES ALL FOR TABLE ${getDb2QualifiedTableName(target)} ALLOW WRITE ACCESS`;
        const sql = `CALL SYSPROC.ADMIN_CMD(${quoteSqlLiteral(commandText)});`;
        const confirmation = await vscode.window.showWarningMessage(
            `Reorganize indexes for table "${target.qualifiedName}"?\n\n${commandText}`,
            { modal: true },
            'Yes, rebuild',
            'Cancel'
        );

        if (confirmation !== 'Yes, rebuild') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `REORG INDEXES ${target.qualifiedName}...`,
            'REORG INDEXES completed successfully',
            'Error during REORG INDEXES'
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'db2');
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
        const rows = await services.executeQuery<Db2PartitionRow>(
          buildListPartitionsQuery(target.schemaName, target.tableName),
          target.connectionName
        );

        return rows.map(row => {
          const partitionBound = `STARTING FROM (${row.LOWVALUE}) ENDING AT (${row.HIGHVALUE})`;
          // approximate byte size based on pages and usual 4k/8k pagesize
          return {
            schema: target.schemaName,
            name: row.PARTITION_NAME,
            parentTable: row.PARENT_TABLE,
            partitionBound: partitionBound,
            partitionStrategy: 'RANGE',
            rowCount: row.ROW_COUNT,
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
        const qualifiedTable = getDb2QualifiedTableName(target);

        let sql = `ALTER TABLE ${qualifiedTable} ADD PARTITION ${options.partitionName} ${options.partitionBound}`;
        if (options.tablespace) {
            sql += ` IN ${options.tablespace}`;
        }
        sql += `;`;

        const confirmation = await vscode.window.showWarningMessage(
            `Add partition "${options.partitionName}" to table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, add',
            'Cancel'
        );

        if (confirmation !== 'Yes, add') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Adding partition ${options.partitionName}...`,
            `Partition ${options.partitionName} added successfully`,
            `Error adding partition`
        );
    },

    async dropPartition(
        target: DatabaseMaintenanceTarget,
        partitionName: string,
        services: DatabaseMaintenanceServices,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _cascade?: boolean,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _partitionSchema?: string
    ): Promise<void> {
        const qualifiedTable = getDb2QualifiedTableName(target);
        const tempTableName = `${target.tableName}_${partitionName}_DETACHED`;
        const qualifiedTemp = formatQualifiedObjectName(
            undefined, target.schemaName, tempTableName, 'db2'
        );

        const sql = [
            `-- Step 1: Detach partition into a standalone table`,
            `ALTER TABLE ${qualifiedTable} DETACH PARTITION ${partitionName} INTO ${qualifiedTemp};`,
            ``,
            `-- Step 2: Drop the detached table`,
            `DROP TABLE ${qualifiedTemp};`
        ].join('\n');

        const confirmation = await vscode.window.showWarningMessage(
            `Drop partition "${partitionName}" from "${target.qualifiedName}"?\n\nThis will detach and then drop the partition data.\nThis action cannot be undone.\n\n${sql}`,
            { modal: true },
            'Yes, drop',
            'Cancel'
        );

        if (confirmation !== 'Yes, drop') {
            return;
        }

        await services.openSqlDocument(sql, 'sql');
    },

    async detachPartition(
        target: DatabaseMaintenanceTarget,
        partitionName: string,
        services: DatabaseMaintenanceServices,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _concurrently?: boolean,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _partitionSchema?: string
    ): Promise<void> {
        const qualifiedTable = getDb2QualifiedTableName(target);
        const detachedTableName = `${target.tableName}_${partitionName}_DETACHED`;

        const userTableName = await vscode.window.showInputBox({
            prompt: 'Enter name for the detached table',
            value: detachedTableName,
            placeHolder: 'Table name for detached partition data',
        });

        if (!userTableName) return;

        const qualifiedDetached = formatQualifiedObjectName(
            undefined, target.schemaName, userTableName, 'db2'
        );
        const sql = `ALTER TABLE ${qualifiedTable} DETACH PARTITION ${partitionName} INTO ${qualifiedDetached};`;

        const confirmation = await vscode.window.showInformationMessage(
            `Detach partition "${partitionName}" into table "${userTableName}"?\n\n${sql}`,
            { modal: true },
            'Yes, detach',
            'Cancel'
        );

        if (confirmation !== 'Yes, detach') {
            return;
        }

        await services.executeAndReport(
            target, sql,
            `Detaching partition ${partitionName}...`,
            `Partition ${partitionName} detached into ${userTableName} successfully`,
            `Error detaching partition`
        );
    },

    async attachPartition(
        target: DatabaseMaintenanceTarget,
        options: DatabaseAttachPartitionOptions,
        services: DatabaseMaintenanceServices
    ): Promise<void> {
        const qualifiedTable = getDb2QualifiedTableName(target);
        const sourceSchema = options.schema || target.schemaName;
        const qualifiedSource = formatQualifiedObjectName(
            undefined, sourceSchema, options.tableName, 'db2'
        );

        const partitionName = await vscode.window.showInputBox({
            prompt: 'Enter partition name for the attached table',
            placeHolder: 'e.g., PART_2024_Q1',
        });

        if (!partitionName) return;

        const attachSql = `ALTER TABLE ${qualifiedTable} ATTACH PARTITION ${partitionName} ${options.partitionBound} FROM TABLE ${qualifiedSource};`;
        const integritySql = `SET INTEGRITY FOR ${qualifiedTable} IMMEDIATE CHECKED;`;

        const action = await vscode.window.showWarningMessage(
            `Attach table "${options.tableName}" as partition of "${target.qualifiedName}"?\n\nNote: SET INTEGRITY is required after attach.`,
            { modal: true },
            'Attach & Validate (Auto)',
            'Open as Script'
        );

        if (!action) {
            return;
        }

        if (action === 'Open as Script') {
            const sql = [
                `-- Step 1: Attach the table as a partition`,
  attachSql,
  ``,
  `-- Step 2: Validate data integrity (REQUIRED after ATTACH)`,
  integritySql
].join('\n');
  await services.openSqlDocument(sql, 'sql');
} else {
// Execution of both sequentially with error handling
await services.executeWithProgress(
`Attaching and Validating Partition ${partitionName}...`,
async () => {
try {
await services.executeSql(attachSql, target.connectionName, 'Attaching partition...');
} catch (error) {
const errorMsg = error instanceof Error ? error.message : String(error);
vscode.window.showErrorMessage(`Failed to attach partition: ${errorMsg}. SET INTEGRITY was not run.`);
throw error;
}
try {
await services.executeSql(integritySql, target.connectionName, 'Validating partition...');
} catch (error) {
const errorMsg = error instanceof Error ? error.message : String(error);
vscode.window.showWarningMessage(`Partition attached but SET INTEGRITY failed: ${errorMsg}. Run manually: ${integritySql}`);
return;
}
vscode.window.showInformationMessage(`Partition ${partitionName} attached and validated successfully.`);
}
);
}
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
        const rows = await services.executeQuery<Db2IndexRow>(
          buildListIndexesDetailedQuery(target.schemaName, target.tableName),
          target.connectionName
        );

        const indexes: DatabaseIndexInfo[] = [];

        for (const row of rows) {
          const columnRows = await services.executeQuery<Db2IndexColumnRow>(
            buildIndexColumnsDetailedQuery(row.INDEX_SCHEMA, row.INDEX_NAME),
            target.connectionName
          );

          let indexType = 'btree';
          if (row.INDEXTYPE === 'CLUS') {
            indexType = 'clustered';
          }

          indexes.push({
            schema: row.INDEX_SCHEMA,
            name: row.INDEX_NAME,
            tableName: row.TABLE_NAME,
            tableSchema: row.TABLE_SCHEMA,
            indexType: indexType,
            isUnique: row.UNIQUERULE === 'U' || row.UNIQUERULE === 'P',
            isPrimary: row.UNIQUERULE === 'P',
            columns: columnRows.map(c => c.COLNAME),
            // definition is not provided by catalog, we construct a dummy or leave empty
            indexSize: row.NLEAF > 0 ? row.NLEAF * 8192 : undefined, // rough estimate
            isValid: true
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
        const qualifiedTable = getDb2QualifiedTableName(target);
        const indexName = options.indexName
            || `${target.tableName}_${options.columns.join('_')}_IDX`;
        const qualifiedIndex = formatQualifiedObjectName(
            undefined, target.schemaName, indexName, 'db2'
        );

        const uniqueKeyword = options.isUnique ? 'UNIQUE ' : '';
        const columnList = options.columns.map(c => `"${c}"`).join(', ');

        let includeClause = '';
        if (options.includeColumns && options.includeColumns.length > 0) {
            const includeList = options.includeColumns.map(c => `"${c}"`).join(', ');
            includeClause = ` INCLUDE (${includeList})`;
        }

        const clusterClause = options.indexType === 'hash' ? ' CLUSTER' : ''; // UI will map cluster to hash type 

        const sql = `CREATE ${uniqueKeyword}INDEX ${qualifiedIndex} ON ${qualifiedTable} (${columnList})${includeClause}${clusterClause};`;

        const confirmation = await vscode.window.showInformationMessage(
            `Create index "${indexName}" on "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, create',
            'Cancel'
        );

        if (confirmation !== 'Yes, create') {
            return;
        }

        await services.executeAndReport(
            target, sql,
            `Creating index ${indexName}...`,
            `Index ${indexName} created successfully`,
            `Error creating index`
        );
    },

    async dropIndex(
        target: DatabaseMaintenanceTarget,
        indexName: string,
        services: DatabaseMaintenanceServices,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _cascade?: boolean,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _concurrently?: boolean
    ): Promise<void> {
        const qualifiedIndex = formatQualifiedObjectName(
            undefined, target.schemaName, indexName, 'db2'
        );
        const sql = `DROP INDEX ${qualifiedIndex};`;

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
            target, sql,
            `Dropping index ${indexName}...`,
            `Index ${indexName} dropped successfully`,
            `Error dropping index`
        );
    },

    async reindexWithOptions(
        target: DatabaseMaintenanceTarget,
        options: { concurrently?: boolean; verbose?: boolean; tablespace?: string },
        services: DatabaseMaintenanceServices
    ): Promise<void> {
        const qualifiedTable = getDb2QualifiedTableName(target);

        const parts = ['REORG INDEXES ALL FOR TABLE', qualifiedTable];

        if (options.verbose) {
            parts.push('CLEANUP ONLY ALL');
        } else {
            parts.push('REBUILD');
        }

        if (options.concurrently) {
            parts.push('ALLOW WRITE ACCESS');
        } else {
            parts.push('ALLOW READ ACCESS');
        }

        const commandText = parts.join(' ');
        const sql = `CALL SYSPROC.ADMIN_CMD(${quoteSqlLiteral(commandText)});`;

        const confirmation = await vscode.window.showWarningMessage(
            `Reorganize indexes for table "${target.qualifiedName}"?\n\nWarning: REORG INDEXES can be disruptive.\n\n${commandText}`,
            { modal: true },
            'Yes, reindex',
            'Cancel'
        );

        if (confirmation !== 'Yes, reindex') {
            return;
        }

        await services.executeAndReport(
            target, sql,
            `Reorg indexes for ${target.qualifiedName}...`,
            'REORG INDEXES completed successfully',
            'Error during REORG INDEXES'
        );
    }
};
