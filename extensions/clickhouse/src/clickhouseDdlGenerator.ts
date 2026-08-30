import type {
    DatabaseAdvancedFeatures,
    DatabaseBatchDDLOptions,
    DatabaseBatchDDLResult,
    DatabaseConnection,
    DatabaseDdlColumnInfo,
    DatabaseDdlKeyInfo,
    DatabaseDdlResult,
    DatabaseTableDefinitionMetadata,
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
    buildTableDefinitionQuery,
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

function unwrapSingleOuterParentheses(value: string): string {
    let result = value.trim();
    let changed = true;
    while (changed && result.startsWith('(') && result.endsWith(')')) {
        changed = false;
        let depth = 0;
        let quote: string | undefined;
        let closesAtEnd = true;
        for (let index = 0; index < result.length; index += 1) {
            const character = result[index];
            if (quote) {
                if (character === '\\') {
                    index += 1;
                } else if (character === quote) {
                    if (result[index + 1] === quote) {
                        index += 1;
                    } else {
                        quote = undefined;
                    }
                }
                continue;
            }
            if (character === "'" || character === '"' || character === '`') {
                quote = character;
            } else if (character === '(' || character === '[') {
                depth += 1;
            } else if (character === ')' || character === ']') {
                depth -= 1;
                if (depth === 0 && index !== result.length - 1) {
                    closesAtEnd = false;
                    break;
                }
            }
        }
        if (closesAtEnd && depth === 0) {
            result = result.slice(1, -1).trim();
            changed = true;
        }
    }
    return result;
}

function splitTopLevelExpressions(value: string): string[] {
    value = unwrapSingleOuterParentheses(value);
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | undefined;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                if (value[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (character === "'" || character === '"' || character === '`') {
            quote = character;
        } else if (character === '(' || character === '[') {
            depth += 1;
        } else if (character === ')' || character === ']') {
            depth = Math.max(0, depth - 1);
        } else if (character === ',' && depth === 0) {
            const part = value.slice(start, index).trim();
            if (part) {
                result.push(part);
            }
            start = index + 1;
        }
    }

    const last = value.slice(start).trim().replace(/;\s*$/, '');
    if (last) {
        result.push(last);
    }
    return result;
}

function isIdentifierCharacter(character: string | undefined): boolean {
    return character !== undefined && /[A-Z0-9_$]/i.test(character);
}

function findTopLevelKeyword(source: string, keyword: string, fromIndex = 0): number {
    const upperSource = source.toUpperCase();
    const upperKeyword = keyword.toUpperCase();
    let depth = 0;
    let quote: string | undefined;

    for (let index = fromIndex; index <= source.length - keyword.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                if (source[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }

        if (character === "'" || character === '"' || character === '`') {
            quote = character;
            continue;
        }
        if (character === '(' || character === '[') {
            depth += 1;
            continue;
        }
        if (character === ')' || character === ']') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0 || !upperSource.startsWith(upperKeyword, index)) {
            continue;
        }

        const before = source[index - 1];
        const after = source[index + keyword.length];
        if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
            return index;
        }
    }
    return -1;
}

const TABLE_DEFINITION_CLAUSES = ['ENGINE', 'PARTITION BY', 'PRIMARY KEY', 'ORDER BY', 'SAMPLE BY', 'TTL', 'SETTINGS'] as const;

function extractTopLevelClause(source: string, clause: string): string | undefined {
    const start = findTopLevelKeyword(source, clause);
    if (start < 0) {
        return undefined;
    }

    let valueStart = start + clause.length;
    if (clause === 'ENGINE') {
        while (/\s/.test(source[valueStart] ?? '')) {
            valueStart += 1;
        }
        if (source[valueStart] === '=') {
            valueStart += 1;
        }
    }
    while (/\s/.test(source[valueStart] ?? '')) {
        valueStart += 1;
    }

    let end = source.length;
    for (const nextClause of TABLE_DEFINITION_CLAUSES) {
        if (nextClause === clause) {
            continue;
        }
        const nextStart = findTopLevelKeyword(source, nextClause, valueStart);
        if (nextStart >= 0 && nextStart < end) {
            end = nextStart;
        }
    }
    const value = source.slice(valueStart, end).trim().replace(/;\s*$/, '');
    return value || undefined;
}

function extractEngineName(engineClause: string | undefined): string | undefined {
    return engineClause?.match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0];
}

function parseTableDefinition(
    sourceDdl: string | undefined,
    fallback: Partial<DatabaseTableDefinitionMetadata> = {},
): DatabaseTableDefinitionMetadata | null {
    const engineClause = sourceDdl ? extractTopLevelClause(sourceDdl, 'ENGINE') : undefined;
    const engine = fallback.engine ?? extractEngineName(engineClause);
    if (!engine) {
        return null;
    }

    const partitionBy = fallback.partitionBy ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'PARTITION BY') : undefined);
    const primaryKey = fallback.primaryKey ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'PRIMARY KEY') : undefined);
    const orderBy = fallback.orderBy ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'ORDER BY') : undefined);
    const sampleBy = fallback.sampleBy ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'SAMPLE BY') : undefined);
    const ttl = fallback.ttl ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'TTL') : undefined);
    const settings = fallback.settings ?? (sourceDdl ? extractTopLevelClause(sourceDdl, 'SETTINGS') : undefined);

    const definition: DatabaseTableDefinitionMetadata = {
        engine,
        ...(engineClause ? { engineClause } : {}),
        ...(partitionBy ? { partitionBy } : {}),
        ...(primaryKey ? { primaryKey } : {}),
        ...(orderBy ? { orderBy } : {}),
        ...(sampleBy ? { sampleBy } : {}),
        ...(ttl ? { ttl } : {}),
        ...(settings ? { settings } : {}),
        ...(sourceDdl ? { sourceDdl } : {}),
    };
    return definition;
}

function ensureStatementTerminator(sql: string): string {
    const trimmed = sql.trim();
    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function replaceCreateTarget(sourceDdl: string, qualifiedName: string): string {
    const prefix = sourceDdl.match(
        /^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)/i,
    );
    if (!prefix) {
        return sourceDdl;
    }

    const rest = sourceDdl.slice(prefix[0].length);
    let quote: string | undefined;
    let end = rest.length;
    for (let index = 0; index < rest.length; index += 1) {
        const character = rest[index];
        if (quote) {
            if (character === quote) {
                if (rest[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }
        if (character === "'" || character === '"' || character === '`') {
            quote = character;
        } else if (/\s/.test(character) || character === '(') {
            end = index;
            break;
        }
    }
    if (end === 0 || end === rest.length) {
        return sourceDdl;
    }
    return `${prefix[0]}${qualifiedName}${rest.slice(end)}`;
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
    return ensureStatementTerminator(statement);
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
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
    tableComment?: string | null,
    _owner?: string | null,
    tableDefinition?: DatabaseTableDefinitionMetadata,
): string {
    const container = schema || database;
    const qualifiedName = formatQualifiedObjectName(container, undefined, tableName, 'clickhouse');
    if (!tableDefinition) {
        throw new Error(
            `ClickHouse table definition metadata is required to build cache-backed DDL for ${container}.${tableName}. Refresh the object metadata first.`,
        );
    }
    if (tableDefinition.sourceDdl) {
        return ensureStatementTerminator(replaceCreateTarget(tableDefinition.sourceDdl, qualifiedName));
    }

    const columnLines = columns.map(buildColumnDefinition);
    const primaryKeyColumns = keysInfo.get('PRIMARY')?.columns.filter(Boolean) ?? [];
    const primaryKey = tableDefinition.primaryKey?.trim()
        || (primaryKeyColumns.length > 1
            ? `(${primaryKeyColumns.join(', ')})`
            : primaryKeyColumns[0]);
    const orderColumns = organizeColumns.filter(Boolean);
    const orderBy = tableDefinition.orderBy?.trim()
        || (orderColumns.length > 1
            ? `(${orderColumns.join(', ')})`
            : orderColumns[0]);
    const engineClause = tableDefinition.engineClause?.trim() || tableDefinition.engine.trim();
    if (!engineClause) {
        throw new Error(`ClickHouse engine metadata is missing for ${container}.${tableName}.`);
    }
    const isMergeTreeFamily = /MergeTree(?:\s*\(|$)/i.test(engineClause);
    const tableOptions = [
        `ENGINE = ${engineClause}`,
        ...(tableDefinition.partitionBy ? [`PARTITION BY ${tableDefinition.partitionBy}`] : []),
        ...(primaryKey ? [`PRIMARY KEY ${primaryKey}`] : []),
        ...(orderBy ? [`ORDER BY ${orderBy}`] : (isMergeTreeFamily ? ['ORDER BY tuple()'] : [])),
        ...(tableDefinition.sampleBy ? [`SAMPLE BY ${tableDefinition.sampleBy}`] : []),
        ...(tableDefinition.ttl ? [`TTL ${tableDefinition.ttl}`] : []),
        ...(tableDefinition.settings ? [`SETTINGS ${tableDefinition.settings}`] : []),
    ];
    const comments = tableComment ? [`\n-- Table comment: ${tableComment.replace(/\r?\n/g, ' ')}`] : [];
    return [
        `CREATE TABLE ${qualifiedName} (`,
        ...columnLines.map((line, index) => `    ${line}${index < columnLines.length - 1 ? ',' : ''}`),
        `) ${tableOptions.join(' ')};`,
        ...comments,
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

async function getTableDefinitionInfo(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string,
): Promise<DatabaseTableDefinitionMetadata | null> {
    const rows = await executeDatabaseQuery<Row>(connection, buildTableDefinitionQuery(database, schema, tableName));
    const row = rows[0];
    if (!row) {
        return null;
    }
    const sourceDdl = getRowString(row, ['CLICKHOUSE_SOURCE_DDL', 'create_table_query']);
    return parseTableDefinition(sourceDdl, {
        engine: getRowString(row, ['CLICKHOUSE_ENGINE', 'engine']),
        partitionBy: getRowString(row, ['CLICKHOUSE_PARTITION_BY', 'partition_key']),
        primaryKey: getRowString(row, ['CLICKHOUSE_PRIMARY_KEY', 'primary_key']),
        orderBy: getRowString(row, ['CLICKHOUSE_ORDER_BY', 'sorting_key']),
        sampleBy: getRowString(row, ['CLICKHOUSE_SAMPLE_BY', 'sampling_key']),
    });
}

function buildPrimaryKeyInfo(rows: Row[]): Map<string, DatabaseDdlKeyInfo> {
    const expression = getRowString(rows[0], ['PRIMARY_KEY_EXPRESSION', 'primary_key']);
    const columns = expression
        ? splitTopLevelExpressions(expression)
        : rows
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
    if (normalizedType !== 'TABLE' && normalizedType !== 'VIEW' && normalizedType !== 'MATERIALIZED VIEW') {
        return { success: false, error: `ClickHouse DDL is not implemented for object type '${objectType}'.` };
    }
    const resolvedDatabase = schema || database;
    return {
        success: true,
        ddlCode: await readCreateTable(connection, resolvedDatabase, objectName),
        ddlFidelity: 'exact',
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
        const objectTypes = (options.objectTypes?.length ? options.objectTypes : ['TABLE', 'VIEW', 'MATERIALIZED VIEW'])
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
                    const rowObjectType = String(row.OBJTYPE ?? objectType).trim().toUpperCase();
                    const result = await generateObjectDdl(connection, options.database, objectSchema, objectName, rowObjectType);
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
            return sortingKey ? splitTopLevelExpressions(sortingKey) : [];
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
        async getTableDefinitionMetadata(connection, database, schema, tableName): Promise<DatabaseTableDefinitionMetadata | null> {
            return getTableDefinitionInfo(connection, database, schema, tableName);
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
