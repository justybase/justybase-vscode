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
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import { MysqlConnection } from './mysqlConnection';
import {
    buildFindTableSchemaQuery as buildMysqlFindTableSchemaQuery,
    buildTableCommentQuery,
    buildTableColumnsQuery,
    buildObjectTypeQuery
} from './mysqlSystemQueries';

interface TextRow {
    [key: string]: unknown;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function getFirstString(row: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
    if (!row) {
        return undefined;
    }

    for (const key of keys) {
        const value = row[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    for (const [key, value] of Object.entries(row)) {
        if (keys.some(candidate => candidate.toLowerCase() === key.toLowerCase()) && typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return undefined;
}

function buildCreateTableStatement(
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
    tableComment?: string | null
): string {
    const bodyLines = columns.map(column => {
        const pieces = [
            formatIdentifierForSql(column.name, 'mysql'),
            column.fullTypeName || 'TEXT'
        ];

        if (column.notNull) {
            pieces.push('NOT NULL');
        }

        if (column.defaultValue != null && column.defaultValue !== '') {
            pieces.push(`DEFAULT ${column.defaultValue}`);
        }

        if (column.description) {
            pieces.push(`COMMENT ${quoteLiteral(column.description)}`);
        }

        return pieces.join(' ');
    });

    for (const [constraintName, keyInfo] of keysInfo) {
        const normalizedType = (keyInfo.type || '').trim().toUpperCase();
        const normalizedTypeChar = (keyInfo.typeChar || '').trim().toUpperCase();
        const columnsList = keyInfo.columns.map(column => formatIdentifierForSql(column, 'mysql')).join(', ');
        if (!columnsList) {
            continue;
        }

        const constraintPrefix = constraintName ? `CONSTRAINT ${formatIdentifierForSql(constraintName, 'mysql')} ` : '';
        if (normalizedTypeChar === 'P' || normalizedType.includes('PRIMARY')) {
            bodyLines.push(`PRIMARY KEY (${columnsList})`);
            continue;
        }
        if (normalizedTypeChar === 'U' || normalizedType.includes('UNIQUE')) {
            bodyLines.push(`${constraintPrefix}UNIQUE (${columnsList})`);
            continue;
        }
        if (normalizedTypeChar === 'R' || normalizedType.includes('FOREIGN')) {
            const referencedTable = keyInfo.pkRelation ? formatIdentifierForSql(keyInfo.pkRelation, 'mysql') : undefined;
            const referencedColumns = keyInfo.pkColumns.map(column => formatIdentifierForSql(column, 'mysql')).join(', ');
            if (!referencedTable || !referencedColumns) {
                continue;
            }

            const referencedSchema = keyInfo.pkSchema ? `${formatIdentifierForSql(keyInfo.pkSchema, 'mysql')}.` : '';
            const updateClause = keyInfo.updateType ? ` ON UPDATE ${keyInfo.updateType}` : '';
            const deleteClause = keyInfo.deleteType ? ` ON DELETE ${keyInfo.deleteType}` : '';
            bodyLines.push(
                `${constraintPrefix}FOREIGN KEY (${columnsList}) REFERENCES ${referencedSchema}${referencedTable} (${referencedColumns})${updateClause}${deleteClause}`
            );
        }
    }

    const ddlBody = bodyLines.map((line, index) => index < bodyLines.length - 1 ? `${line},` : line);
    const ddl = [
        `CREATE TABLE ${formatQualifiedObjectName(undefined, schema, tableName, 'mysql')} (`,
        ...ddlBody.map(line => `    ${line}`),
        ') ENGINE=InnoDB'
    ];

    if (tableComment && tableComment.trim().length > 0) {
        ddl[ddl.length - 1] += ` COMMENT=${quoteLiteral(tableComment.trim())}`;
    }

    return `${ddl.join('\n')};`;
}

async function withConnection<T>(
    details: ConnectionDetails,
    callback: (connection: DatabaseConnection) => Promise<T>
): Promise<T> {
    const connection = new MysqlConnection({
        host: details.host,
        port: details.port,
        database: details.database,
        user: details.user,
        password: details.password,
        options: details.options
    });

    await connection.connect();
    try {
        return await callback(connection);
    } finally {
        await connection.close();
    }
}

async function readShowCreateStatement(connection: DatabaseConnection, sql: string, candidateKeys: readonly string[]): Promise<string> {
    const rows = await executeDatabaseQuery<TextRow>(connection, sql);
    const statement = getFirstString(rows[0], candidateKeys);
    if (!statement) {
        throw new Error(`MySQL did not return a CREATE statement for ${sql}.`);
    }

    return statement.endsWith(';') ? statement : `${statement};`;
}

function normalizeRoutineName(signature: string): string {
    const trimmed = signature.trim();
    const parenIndex = trimmed.indexOf('(');
    return parenIndex >= 0 ? trimmed.slice(0, parenIndex).trim() : trimmed;
}

async function generateRoutineDdl(
    connection: DatabaseConnection,
    schema: string,
    procSignature: string,
    routineKind: 'PROCEDURE' | 'FUNCTION'
): Promise<string> {
    const routineName = normalizeRoutineName(procSignature);
    return readShowCreateStatement(
        connection,
        `SHOW CREATE ${routineKind} ${formatQualifiedObjectName(undefined, schema, routineName, 'mysql')}`,
        [`Create ${routineKind[0]}${routineKind.slice(1).toLowerCase()}`, `Create ${routineKind}`, 'Create Statement', 'SQL Original Statement']
    );
}

async function generateTriggerOrEventDdl(
    connection: DatabaseConnection,
    schema: string,
    objectName: string,
    objectType: 'TRIGGER' | 'EVENT'
): Promise<string> {
    return readShowCreateStatement(
        connection,
        `SHOW CREATE ${objectType} ${formatQualifiedObjectName(undefined, schema, objectName, 'mysql')}`,
        [`Create ${objectType[0]}${objectType.slice(1).toLowerCase()}`, `Create ${objectType}`, 'SQL Original Statement']
    );
}

async function resolveTableSchema(connection: DatabaseConnection, schema: string, tableName: string): Promise<string> {
    const normalizedSchema = schema.trim();
    if (normalizedSchema.length > 0) {
        return normalizedSchema;
    }

    const rows = await executeDatabaseQuery<TextRow>(connection, buildMysqlFindTableSchemaQuery('', tableName));
    const resolved = getFirstString(rows[0], ['SCHEMA']);
    if (resolved) {
        return resolved;
    }

    throw new Error(`Schema is required to generate DDL for table ${tableName}.`);
}

async function getTableColumnsAndKeys(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    tableName: string
): Promise<{
    columns: DatabaseDdlColumnInfo[];
    keysInfo: Map<string, DatabaseDdlKeyInfo>;
    tableComment: string | null;
}> {
    const columnRows = await executeDatabaseQuery<Record<string, unknown>>(connection, buildTableColumnsQuery(database, schema, tableName));
    const keyRows = await executeDatabaseQuery<Record<string, unknown>>(connection, `
        SELECT
            tc.CONSTRAINT_NAME AS CONSTNAME,
            tc.CONSTRAINT_TYPE AS TYPE,
            CASE
                WHEN tc.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 'P'
                WHEN tc.CONSTRAINT_TYPE = 'UNIQUE' THEN 'U'
                WHEN tc.CONSTRAINT_TYPE = 'FOREIGN KEY' THEN 'R'
                ELSE tc.CONSTRAINT_TYPE
            END AS TYPECHAR,
            kcu.COLUMN_NAME AS COLNAME,
            kcu.REFERENCED_TABLE_SCHEMA AS PKSCHEMA,
            kcu.REFERENCED_TABLE_NAME AS PKRELATION,
            kcu.REFERENCED_COLUMN_NAME AS PKCOLNAME,
            rc.UPDATE_RULE AS UPDATETYPE,
            rc.DELETE_RULE AS DELETETYPE
        FROM information_schema.table_constraints tc
        INNER JOIN information_schema.key_column_usage kcu
            ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
           AND kcu.TABLE_NAME = tc.TABLE_NAME
           AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        LEFT JOIN information_schema.referential_constraints rc
            ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
           AND rc.TABLE_NAME = tc.TABLE_NAME
           AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = ${quoteLiteral(schema)}
          AND tc.TABLE_NAME = ${quoteLiteral(tableName)}
          AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
        ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `);
    const commentRows = await executeDatabaseQuery<Record<string, unknown>>(connection, buildTableCommentQuery(database, schema, tableName));

    const columns = columnRows.map(row => ({
        name: String(row.ATTNAME ?? row.COLUMN_NAME ?? ''),
        description: row.DESCRIPTION != null ? String(row.DESCRIPTION) : null,
        fullTypeName: String(row.FULL_TYPE ?? row.COLUMN_TYPE ?? row.DATA_TYPE ?? ''),
        notNull: !String(row.IS_NULLABLE ?? '').toUpperCase().includes('YES'),
        defaultValue: row.COLDEFAULT != null ? String(row.COLDEFAULT) : null
    }));

    const keysInfo = new Map<string, DatabaseDdlKeyInfo>();
    for (const row of keyRows) {
        const constraintName = String(row.CONSTNAME ?? `KEY_${keysInfo.size + 1}`);
        const existing = keysInfo.get(constraintName) ?? {
            type: String(row.TYPE ?? ''),
            typeChar: String(row.TYPECHAR ?? ''),
            columns: [],
            pkDatabase: null,
            pkSchema: row.PKSCHEMA != null ? String(row.PKSCHEMA) : null,
            pkRelation: row.PKRELATION != null ? String(row.PKRELATION) : null,
            pkColumns: [],
            updateType: String(row.UPDATETYPE ?? ''),
            deleteType: String(row.DELETETYPE ?? '')
        };

        if (row.COLNAME != null) {
            existing.columns.push(String(row.COLNAME));
        }
        if (row.PKCOLNAME != null) {
            existing.pkColumns.push(String(row.PKCOLNAME));
        }

        keysInfo.set(constraintName, existing);
    }

    const tableComment = typeof commentRows[0]?.DESCRIPTION === 'string' ? String(commentRows[0].DESCRIPTION) : null;

    return {
        columns,
        keysInfo,
        tableComment
    };
}

async function generateObjectDdl(
    connection: DatabaseConnection,
    database: string,
    schema: string,
    objectName: string,
    objectType: string
): Promise<DatabaseDdlResult> {
    const resolvedSchema = schema || database;
    switch (objectType.trim().toUpperCase()) {
        case 'TABLE': {
            const { columns, keysInfo, tableComment } = await getTableColumnsAndKeys(connection, database, resolvedSchema, objectName);
            if (columns.length === 0) {
                return {
                    success: false,
                    error: `MySQL table ${resolvedSchema}.${objectName} was not found or has no columns.`
                };
            }

            return {
                success: true,
                ddlCode: buildCreateTableStatement(resolvedSchema, objectName, columns, keysInfo, tableComment),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName,
                    objectType: 'TABLE'
                }
            };
        }
        case 'VIEW':
            return {
                success: true,
                ddlCode: await readShowCreateStatement(
                    connection,
                    `SHOW CREATE VIEW ${formatQualifiedObjectName(undefined, resolvedSchema, objectName, 'mysql')}`,
                    ['Create View', 'SQL Original Statement']
                ),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName,
                    objectType: 'VIEW'
                }
            };
        case 'PROCEDURE':
            return {
                success: true,
                ddlCode: await generateRoutineDdl(connection, resolvedSchema, objectName, 'PROCEDURE'),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName: normalizeRoutineName(objectName),
                    objectType: 'PROCEDURE'
                }
            };
        case 'FUNCTION':
            return {
                success: true,
                ddlCode: await generateRoutineDdl(connection, resolvedSchema, objectName, 'FUNCTION'),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName: normalizeRoutineName(objectName),
                    objectType: 'FUNCTION'
                }
            };
        case 'TRIGGER':
            return {
                success: true,
                ddlCode: await generateTriggerOrEventDdl(connection, resolvedSchema, objectName, 'TRIGGER'),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName,
                    objectType: 'TRIGGER'
                }
            };
        case 'EVENT':
            return {
                success: true,
                ddlCode: await generateTriggerOrEventDdl(connection, resolvedSchema, objectName, 'EVENT'),
                objectInfo: {
                    database,
                    schema: resolvedSchema,
                    objectName,
                    objectType: 'EVENT'
                }
            };
        default:
            return {
                success: false,
                error: `MySQL DDL is not implemented for object type '${objectType}'.`
            };
    }
}
import { mysqlImportTypeMapper } from './mysqlImportTypeMapper';
import { mysqlMaintenanceProvider } from './mysqlMaintenanceProvider';
import { mysqlCopilotReferenceProvider } from './mysqlReferenceProvider';
import { mysqlSessionMonitorProvider } from './mysqlSessionMonitorProvider';
import { mysqlTuningAdvisor } from './mysqlTuningAdvisor';

export const mysqlAdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: mysqlImportTypeMapper,
    maintenance: mysqlMaintenanceProvider,
    copilotReferenceProvider: mysqlCopilotReferenceProvider,
    sessionMonitor: mysqlSessionMonitorProvider,
    tuningAdvisor: mysqlTuningAdvisor,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'mysql');
        },
        buildFindTableSchemaQuery(_database: string, tableName: string): string {
            return buildMysqlFindTableSchemaQuery('', tableName);
        },
        buildTableStatsQuery(_database: string, schema: string, tableName: string): string {
            return `SELECT COUNT(*) AS "ROW_COUNT" FROM ${formatQualifiedObjectName(undefined, schema, tableName, 'mysql')}`;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 0 AS "DATASLICEID", COUNT(*) AS "ROW_COUNT" FROM ${qualifiedTableName}`;
        },
        async getColumns(connection: DatabaseConnection, database: string, schema: string, tableName: string): Promise<DatabaseDdlColumnInfo[]> {
            const { columns } = await getTableColumnsAndKeys(connection, database, schema, tableName);
            return columns;
        },
        async getDistributionInfo(): Promise<string[]> {
            return [];
        },
        async getOrganizeInfo(): Promise<string[]> {
            return [];
        },
        async getKeysInfo(connection: DatabaseConnection, database: string, schema: string, tableName: string): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const { keysInfo } = await getTableColumnsAndKeys(connection, database, schema, tableName);
            return keysInfo;
        },
        async getTableComment(connection: DatabaseConnection, database: string, schema: string, tableName: string): Promise<string | null> {
            const rows = await executeDatabaseQuery<Record<string, unknown>>(connection, buildTableCommentQuery(database, schema, tableName));
            return typeof rows[0]?.DESCRIPTION === 'string' && String(rows[0].DESCRIPTION).trim().length > 0
                ? String(rows[0].DESCRIPTION)
                : null;
        },
        async getTableOwner(): Promise<string | null> {
            return null;
        },
        async generateTableDDL(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<string> {
            const resolvedSchema = await resolveTableSchema(connection, schema, tableName);
            return readShowCreateStatement(
                connection,
                `SHOW CREATE TABLE ${formatQualifiedObjectName(undefined, resolvedSchema, tableName, 'mysql')}`,
                ['Create Table', 'SQL Original Statement']
            );
        },
        buildTableDDLFromCache(
            database: string,
            schema: string,
            tableName: string,
            columns: DatabaseDdlColumnInfo[],
            _distributionColumns: string[],
            _organizeColumns: string[],
            keysInfo: Map<string, DatabaseDdlKeyInfo>,
            tableComment?: string | null
        ): string {
            return buildCreateTableStatement(schema || database, tableName, columns, keysInfo, tableComment);
        },
        async generateViewDDL(connection: DatabaseConnection, database: string, schema: string, viewName: string): Promise<string> {
            return readShowCreateStatement(
                connection,
                `SHOW CREATE VIEW ${formatQualifiedObjectName(undefined, schema || database, viewName, 'mysql')}`,
                ['Create View', 'SQL Original Statement']
            );
        },
        async generateProcedureDDL(connection: DatabaseConnection, database: string, schema: string, procSignature: string): Promise<string> {
            return generateRoutineDdl(connection, schema || database, procSignature, 'PROCEDURE');
        },
        async generateExternalTableDDL(): Promise<string> {
            throw new Error('MySQL external table DDL is not supported.');
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('MySQL synonym DDL is not supported.');
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            return withConnection(options.connectionDetails, async connection => {
                const schema = options.schema ?? options.database;
                const objectTypes = (options.objectTypes && options.objectTypes.length > 0
                    ? options.objectTypes
                    : ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'])
                    .map(type => type.trim().toUpperCase());

                const ddlParts: string[] = [];
                const errors: string[] = [];
                let objectCount = 0;

                for (const objectType of objectTypes) {
                    const objects = await executeDatabaseQuery<Record<string, unknown>>(connection, buildObjectTypeQuery(options.database, objectType));
                    for (const row of objects) {
                        const objectName = String(row.OBJNAME ?? '');
                        const objectSchema = String(row.SCHEMA ?? schema ?? options.database);
                        if (!objectName) {
                            continue;
                        }

                        const ddlResult = await generateObjectDdl(connection, options.database, objectSchema, objectName, objectType);
                        if (ddlResult.success && ddlResult.ddlCode) {
                            ddlParts.push(ddlResult.ddlCode);
                            objectCount += 1;
                        } else if (ddlResult.error) {
                            errors.push(ddlResult.error);
                        }
                    }
                }

                return {
                    success: errors.length === 0,
                    ddlCode: ddlParts.join('\n\n'),
                    objectCount,
                    errors,
                    skipped: 0
                };
            });
        },
        async generateDDL(
            connectionDetails: ConnectionDetails,
            database: string,
            schema: string,
            objectName: string,
            objectType: string
        ): Promise<DatabaseDdlResult> {
            return withConnection(connectionDetails, connection => generateObjectDdl(connection, database, schema, objectName, objectType));
        }
    }
};
