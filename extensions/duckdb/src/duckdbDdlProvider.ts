import type {
    DatabaseAdvancedFeatures,
    DatabaseBatchDDLOptions,
    DatabaseBatchDDLResult,
    DatabaseConnection,
    DatabaseDdlColumnInfo,
    DatabaseDdlKeyInfo,
    DatabaseDdlResult
} from '@justybase/contracts';
import type { ConnectionDetails } from '../../../src/types';
import { executeDatabaseQuery } from '../../../src/core/connectionFactory';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import { DuckDbConnection } from './duckdbConnection';

interface ColumnRow {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number;
    COLDEFAULT?: string | null;
    DESCRIPTION?: string | null;
}

interface ViewDefRow {
    view_definition?: string | null;
}

interface SqliteParamRow {
    sql?: string | null;
}

type DuckDbDdlProvider = NonNullable<DatabaseAdvancedFeatures['ddl']>;

function buildQualifiedName(schema: string | undefined, objectName: string): string {
  const formattedObjectName = formatIdentifierForSql(objectName, 'duckdb');
  if (!schema || schema.toLowerCase() === 'main') {
    return formattedObjectName;
  }
  return `${formatIdentifierForSql(schema, 'duckdb')}.${formattedObjectName}`;
}

function buildColumnDefinition(column: DatabaseDdlColumnInfo): string {
  const parts = [formatIdentifierForSql(column.name, 'duckdb'), column.fullTypeName];
    if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue.trim().length > 0) {
        parts.push(`DEFAULT ${column.defaultValue.trim()}`);
    }
    if (column.notNull) {
        parts.push('NOT NULL');
    }
    return parts.join(' ');
}

async function createConnectionFromDetails(connectionDetails: ConnectionDetails): Promise<DatabaseConnection> {
    const connection = new DuckDbConnection({
        host: connectionDetails.host || 'localhost',
        user: connectionDetails.user || 'duckdb',
        database: connectionDetails.database,
        options: connectionDetails.options
    });
    await connection.connect();
    return connection;
}

async function getSqliteMasterDdl(
  connection: DatabaseConnection,
  schema: string,
  objectName: string,
  objectType: 'table' | 'view'
): Promise<string | null> {
  const schemaPrefix = schema && schema.toLowerCase() !== 'main'
    ? `${formatIdentifierForSql(schema, 'duckdb')}.`
    : '';
  const query = `SELECT sql FROM ${schemaPrefix}sqlite_master WHERE type='${objectType}' AND name='${objectName.replace(/'/g, "''")}'`;
  try {
    const rows = await executeDatabaseQuery<SqliteParamRow>(connection, query);
    if (rows.length > 0 && rows[0].sql) {
      let sql = rows[0].sql.trim();
      if (!sql.endsWith(';')) sql += ';';
      return sql;
    }
  } catch {
    // Ignore errors - sqlite_master may not exist in all DuckDB configurations
  }
  return null;
}

export const duckdbDdlProvider: DuckDbDdlProvider = {
  quoteNameIfNeeded(name: string): string {
    return formatIdentifierForSql(name, 'duckdb');
  },
  buildFindTableSchemaQuery(_database: string, tableName: string): string {
    return `SELECT table_schema FROM information_schema.tables WHERE table_name = '${tableName.replace(/'/g, "''")}' LIMIT 1`;
  },
  buildTableStatsQuery(_database: string, schema: string, tableName: string): string {
    const qualifiedName = buildQualifiedName(schema, tableName);
    return `SELECT COUNT(*) AS row_count FROM ${qualifiedName}`;
  },
    buildSkewCheckQuery(qualifiedTableName: string): string {
        return `SELECT 1 AS DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName}`;
    },
    async getColumns(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        tableName: string
    ): Promise<DatabaseDdlColumnInfo[]> {
        const query = `
            SELECT 
                column_name AS ATTNAME,
                data_type AS FORMAT_TYPE,
                CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
                column_default AS COLDEFAULT,
                '' AS DESCRIPTION
            FROM information_schema.columns
            WHERE table_schema = '${schema.replace(/'/g, "''")}'
              AND table_name = '${tableName.replace(/'/g, "''")}'
            ORDER BY ordinal_position
        `;
        const rows = await executeDatabaseQuery<ColumnRow>(connection, query);
        return rows.map(row => ({
            name: row.ATTNAME || '',
            description: row.DESCRIPTION || null,
            fullTypeName: row.FORMAT_TYPE || 'VARCHAR',
            notNull: row.IS_NOT_NULL === 1,
            defaultValue: row.COLDEFAULT ? String(row.COLDEFAULT) : null
        }));
    },
    async getDistributionInfo(): Promise<string[]> {
        return [];
    },
    async getOrganizeInfo(): Promise<string[]> {
        return [];
    },
    async getKeysInfo(): Promise<Map<string, DatabaseDdlKeyInfo>> {
        return new Map<string, DatabaseDdlKeyInfo>();
    },
    async getTableComment(): Promise<string | null> {
        return null;
    },
    async getTableOwner(): Promise<string | null> {
        return null; // DuckDB doesn't have owners in the traditional sense
    },
    async generateTableDDL(
      connection: DatabaseConnection,
      database: string,
      schema: string,
      tableName: string
    ): Promise<string> {
      const primaryDdl = await getSqliteMasterDdl(connection, schema, tableName, 'table');
      if (primaryDdl) {
        return primaryDdl;
      }
  
      const columns = await this.getColumns(connection, database, schema, tableName);
      return this.buildTableDDLFromCache(database, schema, tableName, columns, [], [], new Map());
    },
    buildTableDDLFromCache(
        _database: string,
        schema: string,
        tableName: string,
        columns: DatabaseDdlColumnInfo[],
        _distributionColumns: string[],
        _organizeColumns: string[],
        _keysInfo: Map<string, DatabaseDdlKeyInfo>,
        _tableComment?: string | null
    ): string {
        const qualifiedTableName = buildQualifiedName(schema, tableName);
        const definitions = columns.map(buildColumnDefinition);

        const ddlParts = [
            `CREATE TABLE ${qualifiedTableName} (\n    ${definitions.join(',\n    ')}\n);`
        ];

        return ddlParts.join('\n\n');
    },
    async generateViewDDL(
      connection: DatabaseConnection,
      _database: string,
      schema: string,
      viewName: string
    ): Promise<string> {
      const primaryDdl = await getSqliteMasterDdl(connection, schema, viewName, 'view');
        if (primaryDdl) {
            return primaryDdl;
        }

        const query = `
            SELECT view_definition 
            FROM information_schema.views 
            WHERE table_schema = '${schema.replace(/'/g, "''")}' 
              AND table_name = '${viewName.replace(/'/g, "''")}'
        `;
        const rows = await executeDatabaseQuery<ViewDefRow>(connection, query);
        const viewText = rows[0]?.view_definition?.trim();
        if (!viewText) {
            throw new Error(`DuckDB view text is unavailable for ${schema}.${viewName}.`);
        }

        let finalDdl = `CREATE OR REPLACE VIEW ${buildQualifiedName(schema, viewName)} AS\n${viewText}`;
        if (!finalDdl.endsWith(';')) finalDdl += ';';
        
        return finalDdl;
    },
    async generateProcedureDDL(): Promise<string> {
        throw new Error('DuckDB does not support stored procedures in this way.');
    },
    async generateExternalTableDDL(): Promise<string> {
        throw new Error('DuckDB external table DDL export is not implemented.');
    },
    async generateSynonymDDL(): Promise<string> {
        throw new Error('DuckDB does not support synonyms.');
    },
    async generateBatchDDL(_options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
        return {
            success: false,
            errors: ['Batch DDL not implemented for DuckDB'],
            objectCount: 0,
            skipped: 0
        };
    },
    async generateDDL(
        connectionDetails: ConnectionDetails,
        database: string,
        schema: string,
        objectName: string,
        objectType: string
    ): Promise<DatabaseDdlResult> {
        const connection = await createConnectionFromDetails(connectionDetails);
        const normalizedType = objectType.trim().toUpperCase();

        try {
            let ddlCode = '';
            if (normalizedType === 'TABLE') {
                ddlCode = await this.generateTableDDL(connection, database, schema, objectName);
            } else if (normalizedType === 'VIEW') {
                ddlCode = await this.generateViewDDL(connection, database, schema, objectName);
            } else {
                throw new Error(`DuckDB DDL generation is not implemented for object type "${objectType}".`);
            }

            return {
                success: true,
                ddlCode,
                objectInfo: {
                    database,
                    schema,
                    objectName,
                    objectType
                }
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            await connection.close();
        }
    }
};
