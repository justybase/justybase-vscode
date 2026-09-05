/**
 * Dialect-aware CREATE TABLE generation for the Visual Table Designer.
 * Pure and VS Code-free so both the webview panel and unit tests can share it.
 */

import { formatIdentifierForSql } from '../utils/identifierUtils';

export interface TableDesignerColumnInput {
    name: string;
    type: string;
    length: string;
    notNull: boolean;
    pk: boolean;
    defaultValue: string;
}

export interface TableDesignerCreateInput {
    databaseKind: string;
    dbName: string;
    schemaName: string | undefined;
    tableName: string;
    tableType: string;
    ifNotExists: boolean;
    columns: TableDesignerColumnInput[];
    distributeColumns: string[];
    organizeNone: boolean;
    organizeColumns: string[];
    tableConstraints: string[];
}

export interface TableDesignerProfile {
    supported: boolean;
    reason?: string;
    dataTypes: readonly string[];
    tableTypeOptions: ReadonlyArray<{ value: string; label: string }>;
    supportsIfNotExists: boolean;
    supportsDistribution: boolean;
    supportsOrganize: boolean;
    newColumnType: string;
    newColumnLength: string;
}

const NETEZZA_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'BYTEINT',
    'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE PRECISION',
    'CHARACTER', 'VARCHAR', 'NCHAR', 'NVARCHAR',
    'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL',
    'BOOLEAN', 'JSON', 'JSONB',
];
const DB2_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL',
    'REAL', 'DOUBLE', 'CHARACTER', 'VARCHAR',
    'NCHAR', 'NVARCHAR', 'DATE', 'TIME', 'TIMESTAMP',
    'BOOLEAN', 'BLOB', 'CLOB', 'JSON',
];
const SQLITE_DATA_TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'];
const POSTGRESQL_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'NUMERIC',
    'REAL', 'DOUBLE PRECISION', 'VARCHAR', 'CHAR', 'TEXT',
    'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
    'BOOLEAN', 'UUID', 'JSONB',
];
const MYSQL_DATA_TYPES = [
    'INT', 'BIGINT', 'SMALLINT', 'DECIMAL',
    'FLOAT', 'DOUBLE', 'VARCHAR', 'CHAR', 'TEXT',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP',
    'BOOLEAN', 'JSON', 'BLOB',
];
const ORACLE_DATA_TYPES = [
    'NUMBER', 'INTEGER', 'FLOAT', 'VARCHAR2', 'CHAR',
    'DATE', 'TIMESTAMP', 'CLOB', 'BLOB', 'RAW', 'BOOLEAN',
];
const MSSQL_DATA_TYPES = [
    'INT', 'BIGINT', 'SMALLINT', 'DECIMAL',
    'FLOAT', 'VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'TEXT',
    'DATE', 'TIME', 'DATETIME2',
    'BIT', 'UNIQUEIDENTIFIER', 'VARBINARY',
];
const VERTICA_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'NUMERIC',
    'FLOAT', 'VARCHAR', 'CHAR', 'DATE', 'TIME', 'TIMESTAMP',
    'BOOLEAN', 'BINARY', 'VARBINARY',
];
const SNOWFLAKE_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'NUMBER',
    'FLOAT', 'VARCHAR', 'CHAR', 'DATE', 'TIME',
    'TIMESTAMP_NTZ', 'TIMESTAMP_TZ', 'BOOLEAN', 'VARIANT', 'BINARY',
];
const DUCKDB_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL',
    'DOUBLE', 'VARCHAR', 'CHAR', 'TEXT',
    'DATE', 'TIME', 'TIMESTAMP', 'BOOLEAN', 'JSON',
];

const TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY = [
    { value: 'PERMANENT', label: 'PERMANENT' },
    { value: 'TEMP', label: 'TEMP' },
    { value: 'TEMPORARY', label: 'TEMPORARY' },
];

function normalizeKind(kind: string | undefined): string {
    return (kind ?? '').trim().toLowerCase();
}

export function isTableDesignerSupported(kind: string | undefined): boolean {
    return getTableDesignerProfile(kind).supported;
}

export function getTableDesignerUnsupportedReason(kind: string | undefined): string | undefined {
    return getTableDesignerProfile(kind).reason;
}

export function getTableDesignerProfile(kind: string | undefined): TableDesignerProfile {
    switch (normalizeKind(kind)) {
        case 'netezza':
            return {
                supported: true,
                dataTypes: NETEZZA_DATA_TYPES,
                tableTypeOptions: [
                    { value: 'PERMANENT', label: 'PERMANENT' },
                    { value: 'TEMP', label: 'TEMP' },
                    { value: 'TEMPORARY', label: 'TEMPORARY' },
                    { value: 'GLOBAL TEMP', label: 'GLOBAL TEMP' },
                ],
                supportsIfNotExists: true,
                supportsDistribution: true,
                supportsOrganize: true,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'db2':
            return {
                supported: true,
                dataTypes: DB2_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'sqlite':
            return {
                supported: true,
                dataTypes: SQLITE_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: true,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'TEXT',
                newColumnLength: '',
            };
        case 'postgresql':
            return {
                supported: true,
                dataTypes: POSTGRESQL_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: true,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'mysql':
            return {
                supported: true,
                dataTypes: MYSQL_DATA_TYPES,
                tableTypeOptions: [
                    { value: 'PERMANENT', label: 'PERMANENT' },
                    { value: 'TEMPORARY', label: 'TEMPORARY' },
                ],
                supportsIfNotExists: true,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'oracle':
            return {
                supported: true,
                dataTypes: ORACLE_DATA_TYPES,
                tableTypeOptions: [
                    { value: 'PERMANENT', label: 'PERMANENT' },
                    { value: 'GLOBAL TEMP', label: 'GLOBAL TEMP' },
                ],
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR2',
                newColumnLength: '255',
            };
        case 'mssql':
            return {
                supported: true,
                dataTypes: MSSQL_DATA_TYPES,
                tableTypeOptions: [
                    { value: 'PERMANENT', label: 'PERMANENT' },
                    { value: 'TEMP', label: 'TEMP' },
                ],
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'NVARCHAR',
                newColumnLength: '255',
            };
        case 'vertica':
            return {
                supported: true,
                dataTypes: VERTICA_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'snowflake':
            return {
                supported: true,
                dataTypes: SNOWFLAKE_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: true,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'duckdb':
        case 'file':
            return {
                supported: true,
                dataTypes: DUCKDB_DATA_TYPES,
                tableTypeOptions: TABLE_TYPE_OPTIONS_PERMANENT_TEMP_TEMPORARY,
                supportsIfNotExists: true,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'clickhouse':
            return {
                supported: false,
                reason: 'ClickHouse requires MergeTree engine options (ORDER BY, PARTITION BY, TTL). Use the SQL editor to create tables.',
                dataTypes: [],
                tableTypeOptions: [],
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        case 'access':
            return {
                supported: false,
                reason: 'The Table Designer is not available for Microsoft Access file connections. Use the SQL editor or the Access file tools.',
                dataTypes: [],
                tableTypeOptions: [],
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
        default:
            return {
                supported: false,
                reason: `The Table Designer is not available for database kind "${normalizeKind(kind) || 'unknown'}".`,
                dataTypes: [],
                tableTypeOptions: [],
                supportsIfNotExists: false,
                supportsDistribution: false,
                supportsOrganize: false,
                newColumnType: 'VARCHAR',
                newColumnLength: '255',
            };
    }
}

function quoteIdentifier(identifier: string, kind: string): string {
    return formatIdentifierForSql(identifier, kind);
}

function buildTargetPath(kind: string, dbName: string, schemaName: string | undefined, tableName: string): string {
    const schema = (schemaName ?? '').trim();
    const database = (dbName ?? '').trim();
    const objectName = quoteIdentifier(tableName, kind);

    if (kind === 'netezza') {
        return `${quoteIdentifier(database || 'SYSTEM', kind)}.${quoteIdentifier(schema || 'ADMIN', kind)}.${objectName}`;
    }
    if (kind === 'sqlite') {
        const catalog = schema || database;
        return catalog ? `${quoteIdentifier(catalog, kind)}.${objectName}` : objectName;
    }
    if (kind === 'mysql' || kind === 'clickhouse') {
        return schema ? `${quoteIdentifier(schema, kind)}.${objectName}` : objectName;
    }
    if (kind === 'snowflake') {
        if (database && schema) {
            return `${quoteIdentifier(database, kind)}.${quoteIdentifier(schema, kind)}.${objectName}`;
        }
        return schema ? `${quoteIdentifier(schema, kind)}.${objectName}` : objectName;
    }
    return schema ? `${quoteIdentifier(schema, kind)}.${objectName}` : objectName;
}

function createTablePrefix(kind: string, tableType: string): string {
    switch (kind) {
        case 'oracle':
            return tableType === 'GLOBAL TEMP' || tableType === 'TEMPORARY'
                ? 'CREATE GLOBAL TEMPORARY TABLE'
                : 'CREATE TABLE';
        case 'mysql':
            return tableType === 'TEMPORARY' || tableType === 'TEMP'
                ? 'CREATE TEMPORARY TABLE'
                : 'CREATE TABLE';
        case 'postgresql':
            return tableType === 'TEMPORARY' || tableType === 'TEMP'
                ? 'CREATE TEMPORARY TABLE'
                : 'CREATE TABLE';
        case 'mssql':
            return 'CREATE TABLE';
        default:
            return tableType === 'PERMANENT' ? 'CREATE TABLE' : `CREATE ${tableType} TABLE`;
    }
}

function isTempTable(tableType: string): boolean {
    return tableType === 'TEMP' || tableType === 'TEMPORARY' || tableType === 'GLOBAL TEMP';
}

const STRING_LIKE_TYPES = new Set([
    'VARCHAR', 'NVARCHAR', 'VARCHAR2', 'CHAR', 'CHARACTER', 'NCHAR', 'TEXT',
    'DATE', 'TIME', 'TIMESTAMP', 'DATETIME', 'TIMESTAMPTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ',
]);

const TYPE_LENGTH_TYPES = new Set([
    'VARCHAR', 'NVARCHAR', 'VARCHAR2', 'CHAR', 'CHARACTER', 'NCHAR',
    'NUMERIC', 'DECIMAL', 'NUMBER',
]);

function renderDefaultValue(value: string, type: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    const upper = trimmed.toUpperCase();
    const functionLike = upper.includes('()')
        || upper === 'CURRENT_DATE'
        || upper === 'CURRENT_TIME'
        || upper === 'CURRENT_TIMESTAMP'
        || upper === 'NOW'
        || upper === 'SYSDATE'
        || upper === 'NULL'
        || upper === 'CURRENT_USER'
        || upper === 'GETDATE';
    if (functionLike) {
        return trimmed;
    }
    if (trimmed.startsWith("'") || trimmed.startsWith('(')) {
        return trimmed;
    }
    if (STRING_LIKE_TYPES.has(type.trim().toUpperCase())) {
        return `'${trimmed.replace(/'/g, "''")}'`;
    }
    return trimmed;
}

function buildColumnDefinition(kind: string, column: TableDesignerColumnInput): string {
    const name = (column.name || '').trim();
    const type = (column.type || '').trim();
    if (!name) {
        throw new Error('Every column needs a name.');
    }
    if (!type) {
        throw new Error(`Column "${name}" needs a data type.`);
    }
    if (/[;]|--|\/\*|\*\/|#/.test(type)) {
        throw new Error(`Column "${name}" type cannot contain SQL statement separators or comments.`);
    }

    let definition = `    ${quoteIdentifier(name, kind)} ${type}`;
    const length = (column.length ?? '').trim();
    if (length && TYPE_LENGTH_TYPES.has(type.toUpperCase())) {
        definition += `(${length})`;
    }

    const defaultValue = renderDefaultValue(column.defaultValue, type);
    if (defaultValue) {
        definition += ` DEFAULT ${defaultValue}`;
    }
    if (column.notNull) {
        definition += ' NOT NULL';
    }

    return definition;
}

/**
 * Generates the CREATE TABLE statement for the current design and dialect.
 * Throws for unsupported dialects and for invalid designs.
 */
export function buildTableDesignerCreateSql(input: TableDesignerCreateInput): string {
    const kind = normalizeKind(input.databaseKind);
    const profile = getTableDesignerProfile(kind);
    if (!profile.supported) {
        throw new Error(profile.reason ?? `Table Designer is not supported for "${kind}".`);
    }

    const tableName = (input.tableName || '').trim();
    if (!tableName) {
        throw new Error('Enter a table name before executing DDL.');
    }
    if (input.columns.length === 0) {
        throw new Error('Add at least one column before executing DDL.');
    }

    const prefix = createTablePrefix(kind, input.tableType);
    const ifNotExistsClause = input.ifNotExists && profile.supportsIfNotExists ? ' IF NOT EXISTS' : '';

    let targetPath = buildTargetPath(kind, input.dbName, input.schemaName, tableName);
    const isMssqlTemp = kind === 'mssql' && isTempTable(input.tableType);
    if (isMssqlTemp) {
        // SQL Server temp tables use the raw #name form without quoting or schema qualification.
        targetPath = `#${tableName}`;
    }

    const columnDefinitions = input.columns.map(column => buildColumnDefinition(kind, column));
    const pkColumns = input.columns
        .filter(column => column.pk)
        .map(column => quoteIdentifier((column.name || '').trim(), kind));

    const constraints = input.tableConstraints
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const lines = [...columnDefinitions];
    if (pkColumns.length > 0) {
        lines.push(`    PRIMARY KEY (${pkColumns.join(', ')})`);
    }
    lines.push(...constraints);

    let ddl = `${prefix}${ifNotExistsClause} ${targetPath} (\n${lines.join(',\n')}\n)`;

    if (profile.supportsDistribution) {
        const distributeColumns = input.distributeColumns
            .map(name => name.trim())
            .filter(name => name.length > 0);
        if (distributeColumns.length > 0) {
            ddl += ` DISTRIBUTE ON (${distributeColumns.map(name => `"${name.replace(/"/g, '""')}"`).join(', ')})`;
        } else {
            ddl += ' DISTRIBUTE ON RANDOM';
        }
    }

    if (profile.supportsOrganize) {
        if (input.organizeNone) {
            ddl += ' ORGANIZE ON NONE';
        } else {
            const organizeColumns = input.organizeColumns
                .map(name => name.trim())
                .filter(name => name.length > 0);
            if (organizeColumns.length > 0) {
                ddl += ` ORGANIZE ON (${organizeColumns.map(name => `"${name.replace(/"/g, '""')}"`).join(', ')})`;
            }
        }
    }

    if (kind === 'oracle' && (input.tableType === 'GLOBAL TEMP' || input.tableType === 'TEMPORARY')) {
        ddl += ' ON COMMIT PRESERVE ROWS';
    }

    return `${ddl};`;
}

/**
 * Display container (database/schema) for the designer header.
 */
export function getTableDesignerContainerDisplay(
    kind: string | undefined,
    dbName: string,
    schemaName: string | undefined,
): string {
    const normalizedKind = normalizeKind(kind);
    const database = (dbName || '').trim();
    const schema = (schemaName ?? '').trim();

    if (normalizedKind === 'netezza') {
        return `${database || 'SYSTEM'}.${schema || 'ADMIN'}`;
    }
    if (normalizedKind === 'sqlite' || normalizedKind === 'access' || normalizedKind === 'mysql') {
        return schema || database;
    }
    if (normalizedKind === 'snowflake') {
        return database && schema ? `${database}.${schema}` : database || schema;
    }
    return database && schema ? `${database}.${schema}` : database || schema;
}