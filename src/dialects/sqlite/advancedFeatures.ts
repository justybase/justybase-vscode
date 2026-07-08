import type {
    DatabaseAdvancedFeatures,
    DatabaseBatchDDLOptions,
    DatabaseBatchDDLResult,
    DatabaseConnection,
    DatabaseDdlColumnInfo,
    DatabaseDdlKeyInfo,
    DatabaseDdlResult
} from '../../contracts/database';
import type { ConnectionDetails } from '../../types';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../utils/identifierUtils';
import { SqliteConnection } from './runtime';

type SqliteMasterType = 'table' | 'view' | 'index' | 'trigger';

interface SqliteMasterRow {
    TYPE?: string;
    NAME?: string;
    SQL?: string | null;
}

interface SqliteTableInfoRow {
    NAME?: string;
    TYPE?: string | null;
    IS_NOT_NULL?: number;
    DEFAULT_VALUE?: string | null;
    PK_ORDER?: number;
}

interface SqliteForeignKeyRow {
    FK_ID?: number;
    FK_SEQ?: number;
    REFERENCED_TABLE?: string;
    COLUMN_NAME?: string;
    REFERENCED_COLUMN?: string;
    UPDATE_TYPE?: string;
    DELETE_TYPE?: string;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function normalizeSqliteCatalog(database?: string, schema?: string): string {
    const candidate = (schema || database || 'main').trim();
    return candidate.length > 0 ? candidate : 'main';
}

function normalizeObjectTypeForMaster(objectType: string): SqliteMasterType | undefined {
    const normalized = objectType.trim().toUpperCase();
    if (normalized === 'TABLE') {
        return 'table';
    }
    if (normalized === 'VIEW') {
        return 'view';
    }
    if (normalized === 'INDEX') {
        return 'index';
    }
    if (normalized === 'TRIGGER') {
        return 'trigger';
    }
    return undefined;
}

function ensureTerminated(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) {
        return trimmed;
    }
    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

async function executeRows<T = Record<string, unknown>>(connection: DatabaseConnection, sql: string): Promise<T[]> {
    const command = connection.createCommand(sql);
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
    } finally {
        await reader.close();
    }

    return rows as T[];
}

async function createConnectionFromDetails(connectionDetails: ConnectionDetails): Promise<DatabaseConnection> {
    const connection = new SqliteConnection({
        host: connectionDetails.host,
        port: connectionDetails.port,
        database: connectionDetails.database,
        user: connectionDetails.user,
        password: connectionDetails.password,
        options: connectionDetails.options
    });
    await connection.connect();
    return connection;
}

async function getSqliteMasterSql(
    connection: DatabaseConnection,
    catalog: string,
    objectType: SqliteMasterType,
    objectName: string
): Promise<string> {
    const catalogIdentifier = formatIdentifierForSql(catalog, 'sqlite');
    const masterRows = await executeRows<SqliteMasterRow>(
        connection,
        `
            SELECT
                type AS TYPE,
                name AS NAME,
                sql AS SQL
            FROM ${catalogIdentifier}.sqlite_master
            WHERE type = '${escapeSqlLiteral(objectType)}'
              AND name = '${escapeSqlLiteral(objectName)}'
            LIMIT 1
        `
    );

    const ddlSql = masterRows[0]?.SQL?.trim();
    if (!ddlSql) {
        throw new Error(`SQLite ${objectType} "${objectName}" does not expose stored DDL in sqlite_master.`);
    }

    return ensureTerminated(ddlSql);
}

function buildConstraintClauses(keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const constraints: string[] = [];

    for (const [, keyInfo] of keysInfo) {
        const columns = keyInfo.columns.map(column => formatIdentifierForSql(column, 'sqlite')).join(', ');
        const normalizedType = keyInfo.type.toUpperCase();

        if ((keyInfo.typeChar || '').toUpperCase() === 'P' || normalizedType.includes('PRIMARY')) {
            constraints.push(`PRIMARY KEY (${columns})`);
            continue;
        }

        if ((keyInfo.typeChar || '').toUpperCase() === 'U' || normalizedType.includes('UNIQUE')) {
            constraints.push(`UNIQUE (${columns})`);
            continue;
        }

        if ((keyInfo.typeChar || '').toUpperCase() === 'R' || normalizedType.includes('FOREIGN')) {
            const referencedTable = keyInfo.pkRelation ? formatIdentifierForSql(keyInfo.pkRelation, 'sqlite') : undefined;
            const referencedColumns = keyInfo.pkColumns.map(column => formatIdentifierForSql(column, 'sqlite')).join(', ');
            if (!referencedTable || !referencedColumns) {
                continue;
            }
            constraints.push(`FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})`);
        }
    }

    return constraints;
}

export const sqliteAdvancedFeatures: DatabaseAdvancedFeatures = {
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'sqlite');
        },
        buildFindTableSchemaQuery(database: string, tableName: string): string {
            const catalog = normalizeSqliteCatalog(database);
            const catalogIdentifier = formatIdentifierForSql(catalog, 'sqlite');
            return `
                SELECT '${escapeSqlLiteral(catalog)}' AS SCHEMA
                WHERE EXISTS (
                    SELECT 1
                    FROM ${catalogIdentifier}.sqlite_master
                    WHERE type = 'table'
                      AND name = '${escapeSqlLiteral(tableName)}'
                )
            `;
        },
        buildTableStatsQuery(database: string, schema: string, tableName: string): string {
            const catalog = normalizeSqliteCatalog(database, schema);
            return `SELECT COUNT(*) AS ROW_COUNT FROM ${formatQualifiedObjectName(catalog, undefined, tableName, 'sqlite')}`;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 1 AS DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName}`;
        },
        async getColumns(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string
        ): Promise<DatabaseDdlColumnInfo[]> {
            const catalog = normalizeSqliteCatalog(database, schema);
            const catalogIdentifier = formatIdentifierForSql(catalog, 'sqlite');
            const rows = await executeRows<SqliteTableInfoRow>(
                connection,
                `
                    SELECT
                        name AS NAME,
                        type AS TYPE,
                        notnull AS IS_NOT_NULL,
                        dflt_value AS DEFAULT_VALUE,
                        pk AS PK_ORDER
                    FROM ${catalogIdentifier}.pragma_table_info('${escapeSqlLiteral(tableName)}')
                    ORDER BY cid
                `
            );

            return rows.map(row => ({
                name: row.NAME || '',
                description: null,
                fullTypeName: row.TYPE?.trim() || 'TEXT',
                notNull: row.IS_NOT_NULL === 1,
                defaultValue: row.DEFAULT_VALUE ?? null
            }));
        },
        async getDistributionInfo(): Promise<string[]> {
            return [];
        },
        async getOrganizeInfo(): Promise<string[]> {
            return [];
        },
        async getKeysInfo(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string
        ): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const catalog = normalizeSqliteCatalog(database, schema);
            const catalogIdentifier = formatIdentifierForSql(catalog, 'sqlite');
            const tableInfoRows = await executeRows<SqliteTableInfoRow>(
                connection,
                `
                    SELECT
                        name AS NAME,
                        pk AS PK_ORDER
                    FROM ${catalogIdentifier}.pragma_table_info('${escapeSqlLiteral(tableName)}')
                    ORDER BY cid
                `
            );
            const foreignKeyRows = await executeRows<SqliteForeignKeyRow>(
                connection,
                `
                    SELECT
                        id AS FK_ID,
                        seq AS FK_SEQ,
                        "table" AS REFERENCED_TABLE,
                        "from" AS COLUMN_NAME,
                        "to" AS REFERENCED_COLUMN,
                        on_update AS UPDATE_TYPE,
                        on_delete AS DELETE_TYPE
                    FROM ${catalogIdentifier}.pragma_foreign_key_list('${escapeSqlLiteral(tableName)}')
                    ORDER BY id, seq
                `
            );

            const keysInfo = new Map<string, DatabaseDdlKeyInfo>();
            const primaryKeyColumns = tableInfoRows
                .filter(row => (row.PK_ORDER ?? 0) > 0)
                .sort((left, right) => (left.PK_ORDER ?? 0) - (right.PK_ORDER ?? 0))
                .map(row => row.NAME || '')
                .filter(column => column.length > 0);

            if (primaryKeyColumns.length > 0) {
                keysInfo.set('PRIMARY', {
                    type: 'PRIMARY KEY',
                    typeChar: 'P',
                    columns: primaryKeyColumns,
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: '',
                    deleteType: ''
                });
            }

            const foreignKeys = new Map<number, DatabaseDdlKeyInfo>();
            for (const row of foreignKeyRows) {
                const keyId = row.FK_ID ?? 0;
                const existing = foreignKeys.get(keyId) ?? {
                    type: 'FOREIGN KEY',
                    typeChar: 'R',
                    columns: [],
                    pkDatabase: catalog,
                    pkSchema: null,
                    pkRelation: row.REFERENCED_TABLE ?? null,
                    pkColumns: [],
                    updateType: row.UPDATE_TYPE ?? '',
                    deleteType: row.DELETE_TYPE ?? ''
                };

                if (row.COLUMN_NAME) {
                    existing.columns.push(row.COLUMN_NAME);
                }
                if (row.REFERENCED_COLUMN) {
                    existing.pkColumns.push(row.REFERENCED_COLUMN);
                }

                foreignKeys.set(keyId, existing);
            }

            foreignKeys.forEach((value, key) => {
                keysInfo.set(`FK_${key}`, value);
            });

            return keysInfo;
        },
        async getTableComment(): Promise<string | null> {
            return null;
        },
        async getTableOwner(): Promise<string | null> {
            return null;
        },
        async generateTableDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string
        ): Promise<string> {
            const catalog = normalizeSqliteCatalog(database, schema);
            return getSqliteMasterSql(connection, catalog, 'table', tableName);
        },
        buildTableDDLFromCache(
            database: string,
            schema: string,
            tableName: string,
            columns: DatabaseDdlColumnInfo[],
            _distributionColumns: string[],
            _organizeColumns: string[],
            keysInfo: Map<string, DatabaseDdlKeyInfo>
        ): string {
            const qualifiedTableName = formatQualifiedObjectName(
                normalizeSqliteCatalog(database, schema),
                undefined,
                tableName,
                'sqlite'
            );
            const columnClauses = columns.map(column => {
                const parts = [formatIdentifierForSql(column.name, 'sqlite'), column.fullTypeName];
                if (column.notNull) {
                    parts.push('NOT NULL');
                }
                if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue !== '') {
                    parts.push(`DEFAULT ${column.defaultValue}`);
                }
                return parts.join(' ');
            });
            const definitionLines = [...columnClauses, ...buildConstraintClauses(keysInfo)];

            return `CREATE TABLE ${qualifiedTableName} (\n    ${definitionLines.join(',\n    ')}\n);`;
        },
        async generateViewDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            viewName: string
        ): Promise<string> {
            const catalog = normalizeSqliteCatalog(database, schema);
            return getSqliteMasterSql(connection, catalog, 'view', viewName);
        },
        async generateProcedureDDL(): Promise<string> {
            throw new Error('SQLite does not support stored procedures.');
        },
        async generateExternalTableDDL(): Promise<string> {
            throw new Error('SQLite does not support external tables.');
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('SQLite does not support synonyms.');
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            const connection = await createConnectionFromDetails(options.connectionDetails);
            try {
                const catalog = normalizeSqliteCatalog(options.database, options.schema);
                const catalogIdentifier = formatIdentifierForSql(catalog, 'sqlite');
                const requestedTypes = (options.objectTypes || [])
                    .map(type => normalizeObjectTypeForMaster(type))
                    .filter((type): type is SqliteMasterType => Boolean(type));

                if (options.objectTypes && options.objectTypes.length > 0 && requestedTypes.length === 0) {
                    return {
                        success: false,
                        objectCount: 0,
                        errors: ['Selected object types are not supported by SQLite DDL export.'],
                        skipped: 0
                    };
                }

                const typeFilter = requestedTypes.length > 0
                    ? `AND type IN (${requestedTypes.map(type => `'${type}'`).join(', ')})`
                    : '';
                const rows = await executeRows<SqliteMasterRow>(
                    connection,
                    `
                        SELECT
                            type AS TYPE,
                            name AS NAME,
                            sql AS SQL
                        FROM ${catalogIdentifier}.sqlite_master
                        WHERE sql IS NOT NULL
                          AND name NOT LIKE 'sqlite_%'
                          ${typeFilter}
                        ORDER BY
                            CASE type
                                WHEN 'table' THEN 1
                                WHEN 'index' THEN 2
                                WHEN 'view' THEN 3
                                WHEN 'trigger' THEN 4
                                ELSE 5
                            END,
                            name
                    `
                );

                const ddlStatements = rows
                    .map(row => row.SQL?.trim() || '')
                    .filter(sql => sql.length > 0)
                    .map(sql => ensureTerminated(sql));

                return {
                    success: ddlStatements.length > 0,
                    ddlCode: ddlStatements.join('\n\n'),
                    objectCount: ddlStatements.length,
                    errors: ddlStatements.length > 0 ? [] : ['No SQLite objects with stored DDL were found.'],
                    skipped: 0
                };
            } finally {
                await connection.close();
            }
        },
        async generateDDL(
            connectionDetails: ConnectionDetails,
            database: string,
            schema: string,
            objectName: string,
            objectType: string
        ): Promise<DatabaseDdlResult> {
            const connection = await createConnectionFromDetails(connectionDetails);
            const normalizedSchema = normalizeSqliteCatalog(database, schema);

            try {
                let ddlCode: string;
                const normalizedObjectType = objectType.trim().toUpperCase();

                if (normalizedObjectType === 'TABLE') {
                    ddlCode = await this.generateTableDDL(connection, database, schema, objectName);
                } else if (normalizedObjectType === 'VIEW') {
                    ddlCode = await this.generateViewDDL(connection, database, schema, objectName);
                } else {
                    const masterType = normalizeObjectTypeForMaster(normalizedObjectType);
                    if (!masterType) {
                        return {
                            success: false,
                            error: `SQLite does not support DDL generation for object type "${objectType}".`
                        };
                    }
                    ddlCode = await getSqliteMasterSql(connection, normalizedSchema, masterType, objectName);
                }

                return {
                    success: true,
                    ddlCode,
                    objectInfo: {
                        database,
                        schema: normalizedSchema,
                        objectName,
                        objectType
                    },
                    note: 'SQLite DDL was read directly from sqlite_master.'
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
    }
};
