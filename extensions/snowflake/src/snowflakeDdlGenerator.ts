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
import { executeDatabaseQuery } from '../../../src/core/connectionFactory';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import { SnowflakeConnection } from './snowflakeConnection';
import { buildColumnMetadataQuery } from './snowflakeSystemQueries';
import { snowflakeImportTypeMapper } from './snowflakeImportTypeMapper';
import { snowflakeCopilotReferenceProvider } from './snowflakeReferenceProvider';
import { snowflakeTuningAdvisor } from './snowflakeTuningAdvisor';

interface DdlRow {
    DDL?: string | null;
}

interface TextRow {
    DESCRIPTION?: string | null;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function buildQualifiedSnowflakeName(
    database: string | undefined,
    schema: string | undefined,
    objectName: string,
): string {
    return [database, schema, objectName]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => formatIdentifierForSql(value, 'snowflake'))
        .join('.');
}

function buildGetDdlQuery(objectType: string, database: string, schema: string, objectName: string): string {
    return `SELECT GET_DDL(${quoteLiteral(objectType.toUpperCase())}, ${quoteLiteral(buildQualifiedSnowflakeName(database, schema, objectName))}) AS DDL`;
}

async function withConnection<T>(
    details: ConnectionDetails,
    callback: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
    const connection = new SnowflakeConnection({
        host: details.host,
        port: details.port,
        database: details.database,
        user: details.user,
        password: details.password,
        options: details.options,
    });

    await connection.connect();
    try {
        return await callback(connection);
    } finally {
        await connection.close();
    }
}

async function getDdl(
    connection: DatabaseConnection,
    objectType: string,
    database: string,
    schema: string,
    objectName: string,
): Promise<string> {
    const rows = await executeDatabaseQuery<DdlRow>(
        connection,
        buildGetDdlQuery(objectType, database, schema, objectName),
    );
    const ddl = rows[0]?.DDL?.trim();
    if (!ddl) {
        throw new Error(`Snowflake did not return DDL for ${objectType} ${schema}.${objectName}.`);
    }

    return ddl.endsWith(';') ? ddl : `${ddl};`;
}

function buildTableDdlFromCache(
    database: string,
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
): string {
    const lines = columns.map((column) => {
        const parts = [formatIdentifierForSql(column.name, 'snowflake'), column.fullTypeName || 'TEXT'];
        if (column.defaultValue && column.defaultValue.trim().length > 0) {
            parts.push(`DEFAULT ${column.defaultValue}`);
        }
        if (column.notNull) {
            parts.push('NOT NULL');
        }
        return `    ${parts.join(' ')}`;
    });

    for (const [constraintName, keyInfo] of keysInfo) {
        if (keyInfo.typeChar?.trim().toUpperCase() !== 'P' || keyInfo.columns.length === 0) {
            continue;
        }

        const columnsSql = keyInfo.columns.map((column) => formatIdentifierForSql(column, 'snowflake')).join(', ');
        const prefix = constraintName ? `CONSTRAINT ${formatIdentifierForSql(constraintName, 'snowflake')} ` : '';
        lines.push(`    ${prefix}PRIMARY KEY (${columnsSql})`);
    }

    return `CREATE TABLE ${buildQualifiedSnowflakeName(database, schema, tableName)} (\n${lines.join(',\n')}\n);`;
}

export const snowflakeAdvancedFeatures: DatabaseAdvancedFeatures = {
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'snowflake');
        },
        buildFindTableSchemaQuery(database: string, tableName: string): string {
            return `
                SELECT TABLE_SCHEMA AS "SCHEMA"
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_CATALOG = ${quoteLiteral(database)}
                  AND TABLE_NAME = ${quoteLiteral(tableName)}
                ORDER BY TABLE_SCHEMA
            `;
        },
        buildTableStatsQuery(database: string, schema: string, tableName: string): string {
            return `
                SELECT ROW_COUNT, BYTES, TABLE_OWNER AS OWNER
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_CATALOG = ${quoteLiteral(database)}
                  AND TABLE_SCHEMA = ${quoteLiteral(schema)}
                  AND TABLE_NAME = ${quoteLiteral(tableName)}
            `;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 1 AS DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName}`;
        },
        async getColumns(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<DatabaseDdlColumnInfo[]> {
            const rows = await executeDatabaseQuery<Record<string, unknown>>(
                connection,
                buildColumnMetadataQuery(database, schema, tableName),
            );
            return rows.map((row) => ({
                name: String(row.ATTNAME ?? ''),
                description: typeof row.DESCRIPTION === 'string' ? row.DESCRIPTION : null,
                fullTypeName: String(row.FULL_TYPE ?? row.DATA_TYPE ?? 'TEXT'),
                notNull: row.ATTNOTNULL === 1 || row.ATTNOTNULL === true,
                defaultValue: typeof row.COLDEFAULT === 'string' ? row.COLDEFAULT : null,
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
            tableName: string,
        ): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const rows = await executeDatabaseQuery<Record<string, unknown>>(
                connection,
                `
                SELECT
                    tc.CONSTRAINT_NAME AS CONSTRAINT_NAME,
                    tc.CONSTRAINT_TYPE AS CONSTRAINT_TYPE,
                    ku.COLUMN_NAME AS COLUMN_NAME,
                    ku.ORDINAL_POSITION AS ORDINAL_POSITION
                FROM ${formatIdentifierForSql(database, 'snowflake')}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                INNER JOIN ${formatIdentifierForSql(database, 'snowflake')}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON ku.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
                   AND ku.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
                   AND ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                WHERE tc.TABLE_CATALOG = ${quoteLiteral(database)}
                  AND tc.TABLE_SCHEMA = ${quoteLiteral(schema)}
                  AND tc.TABLE_NAME = ${quoteLiteral(tableName)}
                ORDER BY tc.CONSTRAINT_NAME, ku.ORDINAL_POSITION
            `,
            );
            const output = new Map<string, DatabaseDdlKeyInfo>();

            for (const row of rows) {
                const constraintName = String(row.CONSTRAINT_NAME ?? '');
                const constraintType = String(row.CONSTRAINT_TYPE ?? '').toUpperCase();
                if (!constraintName || !constraintType) {
                    continue;
                }

                const entry = output.get(constraintName) ?? {
                    type: constraintType,
                    typeChar: constraintType === 'PRIMARY KEY' ? 'P' : constraintType === 'UNIQUE' ? 'U' : 'R',
                    columns: [],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: '',
                    deleteType: '',
                };
                const columnName = String(row.COLUMN_NAME ?? '');
                if (columnName) {
                    entry.columns.push(columnName);
                }
                output.set(constraintName, entry);
            }

            return output;
        },
        async getTableComment(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<TextRow>(
                connection,
                `
                SELECT COMMENT AS DESCRIPTION
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_CATALOG = ${quoteLiteral(database)}
                  AND TABLE_SCHEMA = ${quoteLiteral(schema)}
                  AND TABLE_NAME = ${quoteLiteral(tableName)}
            `,
            );
            return rows[0]?.DESCRIPTION?.trim() || null;
        },
        async getTableOwner(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<Record<string, unknown>>(
                connection,
                `
                SELECT TABLE_OWNER AS OWNER
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_CATALOG = ${quoteLiteral(database)}
                  AND TABLE_SCHEMA = ${quoteLiteral(schema)}
                  AND TABLE_NAME = ${quoteLiteral(tableName)}
            `,
            );
            const owner = rows[0]?.OWNER;
            return typeof owner === 'string' && owner.trim().length > 0 ? owner : null;
        },
        async generateTableDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string> {
            return getDdl(connection, 'TABLE', database, schema, tableName);
        },
        buildTableDDLFromCache(
            database: string,
            schema: string,
            tableName: string,
            columns: DatabaseDdlColumnInfo[],
            _distributionColumns: string[],
            _organizeColumns: string[],
            keysInfo: Map<string, DatabaseDdlKeyInfo>,
        ): string {
            return buildTableDdlFromCache(database, schema, tableName, columns, keysInfo);
        },
        async generateViewDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            viewName: string,
        ): Promise<string> {
            return getDdl(connection, 'VIEW', database, schema, viewName);
        },
        async generateProcedureDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            procSignature: string,
        ): Promise<string> {
            return getDdl(connection, 'PROCEDURE', database, schema, procSignature.replace(/\s*\(.*/, ''));
        },
        async generateExternalTableDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string> {
            return getDdl(connection, 'EXTERNAL TABLE', database, schema, tableName);
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('Snowflake does not expose synonym DDL through this MVP provider.');
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            const supportedObjectTypes =
                options.objectTypes && options.objectTypes.length > 0
                    ? options.objectTypes
                    : ['TABLE', 'VIEW', 'DYNAMIC TABLE', 'PROCEDURE', 'FUNCTION', 'SEQUENCE', 'STAGE', 'STREAM', 'TASK', 'FILE FORMAT'];
            const collectedStatements: string[] = [];
            const errors: string[] = [];

            await withConnection(options.connectionDetails, async (connection) => {
                for (const objectType of supportedObjectTypes) {
                    try {
                        const rows = await executeDatabaseQuery<Record<string, unknown>>(
                            connection,
                            `
                            ${
                                objectType.toUpperCase() === 'TABLE'
                                    ? `
                            SELECT TABLE_NAME AS OBJECT_NAME, TABLE_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.TABLES
                            WHERE TABLE_CATALOG = ${quoteLiteral(options.database)}
                              AND TABLE_TYPE = 'BASE TABLE'
                              ${options.schema ? `AND TABLE_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                    : objectType.toUpperCase() === 'DYNAMIC TABLE'
                                      ? `
                            SELECT TABLE_NAME AS OBJECT_NAME, TABLE_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.TABLES
                            WHERE TABLE_CATALOG = ${quoteLiteral(options.database)}
                              AND TABLE_TYPE = 'DYNAMIC TABLE'
                              ${options.schema ? `AND TABLE_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                      : objectType.toUpperCase() === 'VIEW'
                                        ? `
                            SELECT TABLE_NAME AS OBJECT_NAME, TABLE_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.VIEWS
                            WHERE TABLE_CATALOG = ${quoteLiteral(options.database)}
                              ${options.schema ? `AND TABLE_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                      : objectType.toUpperCase() === 'PROCEDURE'
                                        ? `
                            SELECT PROCEDURE_NAME AS OBJECT_NAME, PROCEDURE_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.PROCEDURES
                            WHERE PROCEDURE_CATALOG = ${quoteLiteral(options.database)}
                              ${options.schema ? `AND PROCEDURE_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                        : objectType.toUpperCase() === 'FUNCTION'
                                          ? `
                            SELECT FUNCTION_NAME AS OBJECT_NAME, FUNCTION_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.FUNCTIONS
                            WHERE FUNCTION_CATALOG = ${quoteLiteral(options.database)}
                              ${options.schema ? `AND FUNCTION_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                          : objectType.toUpperCase() === 'SEQUENCE'
                                            ? `
                            SELECT SEQUENCE_NAME AS OBJECT_NAME, SEQUENCE_SCHEMA AS OBJECT_SCHEMA
                            FROM INFORMATION_SCHEMA.SEQUENCES
                            WHERE SEQUENCE_CATALOG = ${quoteLiteral(options.database)}
                              ${options.schema ? `AND SEQUENCE_SCHEMA = ${quoteLiteral(options.schema)}` : ''}
                            `
                                            : `SELECT CAST(NULL AS VARCHAR) AS OBJECT_NAME, CAST(NULL AS VARCHAR) AS OBJECT_SCHEMA WHERE 1 = 0`
                            }
                        `,
                        );

                        for (const row of rows) {
                            const objectName = String(row.OBJECT_NAME ?? '');
                            const objectSchema = String(row.OBJECT_SCHEMA ?? options.schema ?? '');
                            if (!objectName || !objectSchema) {
                                continue;
                            }
                            collectedStatements.push(
                                await getDdl(connection, objectType, options.database, objectSchema, objectName),
                            );
                        }
                    } catch (error) {
                        errors.push(`${objectType}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            });

            return {
                success: errors.length === 0,
                ddlCode: collectedStatements.join('\n\n'),
                objectCount: collectedStatements.length,
                errors,
                skipped: 0,
            };
        },
        async generateDDL(
            connectionDetails: ConnectionDetails,
            database: string,
            schema: string,
            objectName: string,
            objectType: string,
        ): Promise<DatabaseDdlResult> {
            try {
                const ddlCode = await withConnection(connectionDetails, (connection) =>
                    getDdl(connection, objectType, database, schema, objectName),
                );
                return {
                    success: true,
                    ddlCode,
                    objectInfo: {
                        database,
                        schema,
                        objectName,
                        objectType: objectType.toUpperCase(),
                    },
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
    },
    importTypeMapper: snowflakeImportTypeMapper,
    tuningAdvisor: snowflakeTuningAdvisor,
    copilotReferenceProvider: snowflakeCopilotReferenceProvider,
};
