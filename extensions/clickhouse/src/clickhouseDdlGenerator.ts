import type {
    DatabaseAdvancedFeatures,
    DatabaseBatchDDLOptions,
    DatabaseBatchDDLResult,
    DatabaseConnection,
    DatabaseDdlColumnInfo,
    DatabaseDdlKeyInfo,
    DatabaseDdlResult,
} from '@justybase/contracts';
import type { ConnectionDetails } from '../../../src/types';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
} from '../../../src/core/connectionFactory';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import {
    buildColumnMetadataQuery,
    buildFindTableSchemaQuery,
    buildObjectTypeQuery,
    buildTableCommentQuery,
    buildTableColumnsQuery,
} from './clickhouseSystemQueries';
import { clickhouseMaintenanceProvider } from './clickhouseMaintenanceProvider';
import { clickhouseSessionMonitorProvider } from './clickhouseSessionMonitorProvider';
import { clickhouseImportTypeMapper } from './clickhouseImportTypeMapper';

type Row = Record<string, unknown>;

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function getRowString(row: Row | undefined, keys: readonly string[]): string | undefined {
    if (!row) {
        return undefined;
    }
    for (const key of keys) {
        const direct = row[key];
        if (typeof direct === 'string' && direct.trim()) {
            return direct.trim();
        }
    }
    for (const [key, value] of Object.entries(row)) {
        if (keys.some(candidate => candidate.toLowerCase() === key.toLowerCase()) && typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

async function withConnection<T>(details: ConnectionDetails, callback: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    const connection = await createConnectedDatabaseConnectionFromDetails({
        host: details.host,
        port: details.port,
        database: details.database,
        user: details.user,
        password: details.password,
        options: details.options,
        dbType: 'clickhouse',
    });
    try {
        return await callback(connection);
    } finally {
        await connection.close();
    }
}

async function readCreateTable(connection: DatabaseConnection, database: string, tableName: string): Promise<string> {
    const rows = await executeDatabaseQuery<Row>(connection, `SHOW CREATE TABLE ${formatQualifiedObjectName(database, undefined, tableName, 'clickhouse')}`);
    const statement = getRowString(rows[0], ['statement', 'create_table_query', 'Create Table', 'CREATE TABLE']);
    if (!statement) {
        throw new Error(`ClickHouse did not return a CREATE statement for ${database}.${tableName}.`);
    }
    return statement.endsWith(';') ? statement : `${statement};`;
}

function buildColumnDefinition(column: DatabaseDdlColumnInfo): string {
    const parts = [formatIdentifierForSql(column.name, 'clickhouse'), column.fullTypeName || 'String'];
    if (column.defaultValue) {
        parts.push(`DEFAULT ${column.defaultValue}`);
    }
    if (column.description) {
        parts.push(`COMMENT ${quoteLiteral(column.description)}`);
    }
    return parts.join(' ');
}

function buildCreateTableFromCache(
    database: string,
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    _distributionColumns: string[],
    organizeColumns: string[],
    _keysInfo: Map<string, DatabaseDdlKeyInfo>,
    _tableComment?: string | null,
): string {
    const container = schema || database;
    const qualifiedName = formatQualifiedObjectName(container, undefined, tableName, 'clickhouse');
    const columnLines = columns.map(buildColumnDefinition);
    const orderColumns = organizeColumns.filter(Boolean).map(column => formatIdentifierForSql(column, 'clickhouse'));
    const orderBy = orderColumns.length === 0 ? 'tuple()' : orderColumns.length === 1 ? orderColumns[0] : `(${orderColumns.join(', ')})`;
    return [
        `CREATE TABLE ${qualifiedName} (`,
        ...columnLines.map((line, index) => `    ${line}${index < columnLines.length - 1 ? ',' : ''}`),
        `) ENGINE = MergeTree ORDER BY ${orderBy};`,
    ].join('\n');
}

async function getColumnInfo(connection: DatabaseConnection, database: string, schema: string, tableName: string): Promise<DatabaseDdlColumnInfo[]> {
    const rows = await executeDatabaseQuery<Row>(connection, buildTableColumnsQuery(database, schema, tableName));
    return rows.map(row => ({
        name: String(row.ATTNAME ?? row.name ?? ''),
        description: row.DESCRIPTION == null ? null : String(row.DESCRIPTION),
        fullTypeName: String(row.FULL_TYPE ?? row.type ?? 'String'),
        notNull: Number(row.IS_NOT_NULL ?? 0) === 1,
        defaultValue: row.COLDEFAULT == null ? null : String(row.COLDEFAULT),
    })).filter(column => column.name.length > 0);
}

function buildPrimaryKeyInfo(rows: Row[]): Map<string, DatabaseDdlKeyInfo> {
    const columns = rows
        .filter(row => Number(row.IS_PK ?? row.is_in_primary_key ?? 0) === 1)
        .sort((left, right) => Number(left.ATTNUM ?? left.position ?? 0) - Number(right.ATTNUM ?? right.position ?? 0))
        .map(row => String(row.ATTNAME ?? row.name ?? ''))
        .filter(Boolean);
    if (columns.length === 0) {
        return new Map();
    }
    return new Map([['PRIMARY', {
        type: 'PRIMARY KEY',
        typeChar: 'P',
        columns,
        pkDatabase: null,
        pkSchema: null,
        pkRelation: null,
        pkColumns: [],
        updateType: '',
        deleteType: '',
    }]]);
}

async function generateObjectDdl(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    objectName: string,
    objectType: string,
): Promise<DatabaseDdlResult> {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType !== 'TABLE' && normalizedType !== 'VIEW') {
        return { success: false, error: `ClickHouse DDL is not implemented for object type '${objectType}'.` };
    }
    const resolvedDatabase = schema || database;
    return {
        success: true,
        ddlCode: await readCreateTable(connection, resolvedDatabase, objectName),
        objectInfo: {
            database,
            schema: resolvedDatabase,
            objectName,
            objectType: normalizedType,
        },
    };
}

async function generateBatchDdl(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
    return withConnection(options.connectionDetails, async connection => {
        const objectTypes = (options.objectTypes?.length ? options.objectTypes : ['TABLE', 'VIEW'])
            .map(type => type.trim().toUpperCase());
        const ddlParts: string[] = [];
        const errors: string[] = [];
        let objectCount = 0;
        for (const objectType of objectTypes) {
            const rows = await executeDatabaseQuery<Row>(connection, buildObjectTypeQuery(options.database, objectType));
            for (const row of rows) {
                const objectName = String(row.OBJNAME ?? '');
                if (!objectName) {
                    continue;
                }
                const objectSchema = String(row.SCHEMA ?? options.schema ?? options.database);
                try {
                    const result = await generateObjectDdl(connection, options.database, objectSchema, objectName, objectType);
                    if (result.ddlCode) {
                        ddlParts.push(result.ddlCode);
                        objectCount += 1;
                    } else if (result.error) {
                        errors.push(result.error);
                    }
                } catch (error) {
                    errors.push(error instanceof Error ? error.message : String(error));
                }
            }
        }
        return {
            success: errors.length === 0,
            ddlCode: ddlParts.join('\n\n'),
            objectCount,
            errors,
            skipped: 0,
        };
    });
}

export const clickhouseAdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: clickhouseImportTypeMapper,
    maintenance: clickhouseMaintenanceProvider,
    sessionMonitor: clickhouseSessionMonitorProvider,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'clickhouse');
        },
        buildFindTableSchemaQuery,
        buildTableStatsQuery(database: string, schema: string, tableName: string): string {
            const effective = schema || database;
            return `
                SELECT
                    total_rows AS ${formatIdentifierForSql('ROW_COUNT', 'clickhouse')},
                    total_bytes AS ${formatIdentifierForSql('TOTAL_SIZE', 'clickhouse')}
                FROM system.tables
                WHERE database = ${quoteLiteral(effective)} AND name = ${quoteLiteral(tableName)}
                LIMIT 1
            `;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT toUInt8(0) AS DATASLICEID, count() AS ROW_COUNT FROM ${qualifiedTableName}`;
        },
        async getColumns(connection, database, schema, tableName): Promise<DatabaseDdlColumnInfo[]> {
            return getColumnInfo(connection, database, schema, tableName);
        },
        async getDistributionInfo(): Promise<string[]> {
            return [];
        },
        async getOrganizeInfo(connection, database, schema, tableName): Promise<string[]> {
            const effective = schema || database;
            const rows = await executeDatabaseQuery<Row>(connection, `
                SELECT sorting_key AS SORTING_KEY
                FROM system.tables
                WHERE database = ${quoteLiteral(effective)} AND name = ${quoteLiteral(tableName)}
                LIMIT 1
            `);
            const sortingKey = getRowString(rows[0], ['SORTING_KEY']);
            return sortingKey ? sortingKey.split(',').map(value => value.trim()).filter(Boolean) : [];
        },
        async getKeysInfo(connection, database, schema, tableName): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const rows = await executeDatabaseQuery<Row>(connection, buildColumnMetadataQuery(database, schema, tableName));
            return buildPrimaryKeyInfo(rows);
        },
        async getTableComment(connection, database, schema, tableName): Promise<string | null> {
            const rows = await executeDatabaseQuery<Row>(connection, buildTableCommentQuery(database, schema, tableName));
            return getRowString(rows[0], ['DESCRIPTION']) ?? null;
        },
        async getTableOwner(): Promise<string | null> {
            return null;
        },
        async generateTableDDL(connection, database, schema, tableName): Promise<string> {
            return readCreateTable(connection, schema || database, tableName);
        },
        buildTableDDLFromCache: buildCreateTableFromCache,
        async generateViewDDL(connection, database, schema, viewName): Promise<string> {
            return readCreateTable(connection, schema || database, viewName);
        },
        async generateProcedureDDL(): Promise<string> {
            throw new Error('ClickHouse does not expose stored procedure DDL through system catalogs.');
        },
        async generateExternalTableDDL(): Promise<string> {
            throw new Error('ClickHouse external table DDL is not supported by this provider.');
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('ClickHouse synonyms are not supported by this provider.');
        },
        generateBatchDDL: generateBatchDdl,
        async generateDDL(connectionDetails: ConnectionDetails, database, schema, objectName, objectType): Promise<DatabaseDdlResult> {
            return withConnection(connectionDetails, connection => generateObjectDdl(connection, database, schema, objectName, objectType));
        },
    },
};
