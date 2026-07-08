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
import { PostgreSqlConnection } from './postgresqlConnection';
import { postgresqlImportTypeMapper } from './postgresqlImportTypeMapper';
import { postgresqlMaintenanceProvider } from './postgresqlMaintenanceProvider';
import { postgresqlCopilotReferenceProvider } from './postgresqlReferenceProvider';
import { postgresqlSessionMonitorProvider } from './postgresqlSessionMonitorProvider';
import { postgresqlTuningAdvisor } from './postgresqlTuningAdvisor';
import {
    buildDdlColumnsQuery,
    buildFindTableSchemaQuery,
    buildKeysInfoQuery,
    buildObjectTypeQuery,
    buildRoutineDefinitionQuery,
    buildSequenceDefinitionQuery,
    buildTableCommentQuery,
    buildTableIndexesQuery,
    buildTableOwnerQuery,
    buildTablePartitionKeyQuery,
    buildTablePartitionsQuery,
    buildTableTriggersQuery,
    buildViewDefinitionQuery,
} from './postgresqlSystemQueries';

interface ColumnRow {
    ATTNAME?: string;
    FULL_TYPE?: string;
    DESCRIPTION?: string | null;
    IS_NOT_NULL?: number | string | boolean;
    COLDEFAULT?: string | null;
}

interface KeyRow {
    CONSTNAME?: string;
    TYPE?: string;
    TYPECHAR?: string;
    COLNAME?: string | null;
    PKSCHEMA?: string | null;
    PKRELATION?: string | null;
    PKCOLNAME?: string | null;
    UPDATERULE?: string | null;
    DELETERULE?: string | null;
}

interface TextRow {
    DESCRIPTION?: string | null;
    OWNER?: string | null;
    SCHEMA?: string | null;
    VIEW_KIND?: string | null;
    VIEW_SQL?: string | null;
    ROUTINE_DDL?: string | null;
    SEQUENCE_DDL?: string | null;
    INDEX_DDL?: string | null;
    TRIGGER_DDL?: string | null;
    PARTITION_KEY?: string | null;
    PARTITION_DDL?: string | null;
}

interface ObjectRow {
    OBJNAME?: string | null;
    SCHEMA?: string | null;
}

const SUPPORTED_BATCH_TYPES = new Set(['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'SEQUENCE']);

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizeBooleanFlag(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

function ensureStatementTerminated(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) {
        return trimmed;
    }

    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function formatQualifiedName(schema: string, objectName: string): string {
    return `${formatIdentifierForSql(schema, 'postgresql')}.${formatIdentifierForSql(objectName, 'postgresql')}`;
}

function formatConstraintColumns(columns: readonly string[]): string {
    return columns.map((column) => formatIdentifierForSql(column, 'postgresql')).join(', ');
}

function buildConstraintClauses(keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const clauses: string[] = [];

    for (const [constraintName, keyInfo] of keysInfo) {
        const normalizedType = (keyInfo.type || '').trim().toUpperCase();
        const normalizedTypeChar = (keyInfo.typeChar || '').trim().toUpperCase();
        const constraintPrefix = constraintName
            ? `CONSTRAINT ${formatIdentifierForSql(constraintName, 'postgresql')} `
            : '';
        const columns = formatConstraintColumns(keyInfo.columns);

        if (!columns) {
            continue;
        }

        if (normalizedTypeChar === 'P' || normalizedType.includes('PRIMARY')) {
            clauses.push(`${constraintPrefix}PRIMARY KEY (${columns})`);
            continue;
        }

        if (normalizedTypeChar === 'U' || normalizedType.includes('UNIQUE')) {
            clauses.push(`${constraintPrefix}UNIQUE (${columns})`);
            continue;
        }

        if (normalizedTypeChar === 'R' || normalizedType.includes('FOREIGN')) {
            const referencedSchema = keyInfo.pkSchema
                ? `${formatIdentifierForSql(keyInfo.pkSchema, 'postgresql')}.`
                : '';
            const referencedTable = keyInfo.pkRelation
                ? formatIdentifierForSql(keyInfo.pkRelation, 'postgresql')
                : undefined;
            const referencedColumns = formatConstraintColumns(keyInfo.pkColumns);
            if (!referencedTable || !referencedColumns) {
                continue;
            }

            const updateClause = keyInfo.updateType ? ` ON UPDATE ${keyInfo.updateType}` : '';
            const deleteClause = keyInfo.deleteType ? ` ON DELETE ${keyInfo.deleteType}` : '';
            clauses.push(
                `${constraintPrefix}FOREIGN KEY (${columns}) REFERENCES ${referencedSchema}${referencedTable} (${referencedColumns})${updateClause}${deleteClause}`,
            );
        }
    }

    return clauses;
}

async function createConnectionFromDetails(
    connectionDetails: ConnectionDetails,
    databaseOverride?: string,
): Promise<DatabaseConnection> {
    const connection = new PostgreSqlConnection({
        host: connectionDetails.host,
        port: connectionDetails.port,
        database: databaseOverride || connectionDetails.database,
        user: connectionDetails.user,
        password: connectionDetails.password,
        options: connectionDetails.options,
    });
    await connection.connect();
    return connection;
}

function rowsToDdlColumns(rows: ColumnRow[]): DatabaseDdlColumnInfo[] {
    return rows.map((row) => ({
        name: row.ATTNAME || '',
        description: row.DESCRIPTION ?? null,
        fullTypeName: row.FULL_TYPE || '',
        notNull: normalizeBooleanFlag(row.IS_NOT_NULL),
        defaultValue: row.COLDEFAULT ?? null,
    }));
}

function rowsToKeyInfoMap(rows: KeyRow[]): Map<string, DatabaseDdlKeyInfo> {
    const keys = new Map<string, DatabaseDdlKeyInfo>();

    for (const row of rows) {
        const constraintName = row.CONSTNAME || `KEY_${keys.size + 1}`;
        const existing = keys.get(constraintName) ?? {
            type: row.TYPE || '',
            typeChar: row.TYPECHAR || '',
            columns: [],
            pkDatabase: null,
            pkSchema: row.PKSCHEMA || null,
            pkRelation: row.PKRELATION || null,
            pkColumns: [],
            updateType: row.UPDATERULE || '',
            deleteType: row.DELETERULE || '',
        };

        if (row.COLNAME) {
            existing.columns.push(row.COLNAME);
        }
        if (row.PKCOLNAME) {
            existing.pkColumns.push(row.PKCOLNAME);
        }

        keys.set(constraintName, existing);
    }

    return keys;
}

async function resolveSchemaIfMissing(
    connection: DatabaseConnection,
    schema: string,
    objectName: string,
    objectType: string,
): Promise<string> {
    if (schema.trim().length > 0) {
        return schema;
    }

    const normalizedType = objectType.trim().toUpperCase();
    if (SUPPORTED_BATCH_TYPES.has(normalizedType)) {
        const rows =
            normalizedType === 'TABLE'
                ? await executeDatabaseQuery<TextRow>(connection, buildFindTableSchemaQuery(objectName))
                : await executeDatabaseQuery<ObjectRow>(connection, buildObjectTypeQuery(normalizedType));
        const resolvedSchema =
            rows
                .find((row) => {
                    const candidate = 'OBJNAME' in row ? row.OBJNAME : objectName;
                    return (
                        typeof candidate === 'string' &&
                        candidate.trim().toUpperCase() === objectName.trim().toUpperCase()
                    );
                })
                ?.SCHEMA?.trim() || rows[0]?.SCHEMA?.trim();
        if (resolvedSchema) {
            return resolvedSchema;
        }
    }

    throw new Error(`Schema is required to generate DDL for ${objectType} ${objectName}.`);
}

async function generateRoutineDdl(
    connection: DatabaseConnection,
    schema: string,
    routineSignature: string,
    routineKind: 'FUNCTION' | 'PROCEDURE',
): Promise<string> {
    const rows = await executeDatabaseQuery<TextRow>(
        connection,
        buildRoutineDefinitionQuery(schema, routineSignature, routineKind),
    );
    const ddl = rows[0]?.ROUTINE_DDL?.trim();
    if (!ddl) {
        throw new Error(
            `PostgreSQL did not return DDL for ${routineKind.toLowerCase()} ${schema}.${routineSignature}.`,
        );
    }

    return ensureStatementTerminated(ddl);
}

async function generateSequenceDdl(
    connection: DatabaseConnection,
    schema: string,
    sequenceName: string,
): Promise<string> {
    const rows = await executeDatabaseQuery<TextRow>(connection, buildSequenceDefinitionQuery(schema, sequenceName));
    const ddl = rows[0]?.SEQUENCE_DDL?.trim();
    if (!ddl) {
        throw new Error(`PostgreSQL did not return DDL for sequence ${schema}.${sequenceName}.`);
    }

    return ensureStatementTerminated(ddl);
}

export const postgresqlAdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: postgresqlImportTypeMapper,
    tuningAdvisor: postgresqlTuningAdvisor,
    maintenance: postgresqlMaintenanceProvider,
    copilotReferenceProvider: postgresqlCopilotReferenceProvider,
    sessionMonitor: postgresqlSessionMonitorProvider,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'postgresql');
        },
        buildFindTableSchemaQuery(_database: string, tableName: string): string {
            return buildFindTableSchemaQuery(tableName);
        },
        buildTableStatsQuery(_database: string, schema: string, tableName: string): string {
            return `SELECT COUNT(*) AS "ROW_COUNT" FROM ${formatQualifiedName(schema, tableName)}`;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 1 AS "DATASLICEID", COUNT(*) AS "ROW_COUNT" FROM ${qualifiedTableName}`;
        },
        async getColumns(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string,
        ): Promise<DatabaseDdlColumnInfo[]> {
            const rows = await executeDatabaseQuery<ColumnRow>(connection, buildDdlColumnsQuery(schema, tableName));
            return rowsToDdlColumns(rows);
        },
        async getDistributionInfo(): Promise<string[]> {
            return [];
        },
        async getOrganizeInfo(): Promise<string[]> {
            return [];
        },
        async getKeysInfo(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string,
        ): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const rows = await executeDatabaseQuery<KeyRow>(connection, buildKeysInfoQuery(schema, tableName));
            return rowsToKeyInfoMap(rows);
        },
        async getTableComment(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTableCommentQuery(database, schema, tableName),
            );
            return rows[0]?.DESCRIPTION ?? null;
        },
        async getTableOwner(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string,
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<TextRow>(connection, buildTableOwnerQuery(schema, tableName));
            return rows[0]?.OWNER ?? null;
        },
        async generateTableDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string,
        ): Promise<string> {
            const columns = await this.getColumns(connection, database, schema, tableName);
            if (columns.length === 0) {
                throw new Error(`Table ${schema}.${tableName} was not found or has no columns.`);
            }

            const keysInfo = await this.getKeysInfo(connection, database, schema, tableName);
            const tableComment = await this.getTableComment(connection, database, schema, tableName);
            const owner = await this.getTableOwner(connection, database, schema, tableName);
            const partitionKeyRows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTablePartitionKeyQuery(schema, tableName),
            );
            const partitionKey = partitionKeyRows[0]?.PARTITION_KEY?.trim() || '';

            let ddl = this.buildTableDDLFromCache(
                database,
                schema,
                tableName,
                columns,
                [],
                [],
                keysInfo,
                tableComment,
                owner,
            );

            if (partitionKey) {
                ddl = ddl.replace(/\n;$/, `\nPARTITION BY ${partitionKey}\n;`);
            }

            const indexRows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTableIndexesQuery(schema, tableName),
            );
            const triggerRows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTableTriggersQuery(schema, tableName),
            );
            const partitionRows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTablePartitionsQuery(schema, tableName),
            );

            const extraStatements = [
                ...indexRows.map((row) => ensureStatementTerminated(row.INDEX_DDL?.trim() || '')).filter(Boolean),
                ...triggerRows.map((row) => ensureStatementTerminated(row.TRIGGER_DDL?.trim() || '')).filter(Boolean),
                ...partitionRows
                    .map((row) => ensureStatementTerminated(row.PARTITION_DDL?.trim() || ''))
                    .filter(Boolean),
            ];

            return [ddl, ...extraStatements].filter(Boolean).join('\n\n');
        },
        buildTableDDLFromCache(
            _database: string,
            schema: string,
            tableName: string,
            columns: DatabaseDdlColumnInfo[],
            _distributionColumns: string[],
            _organizeColumns: string[],
            keysInfo: Map<string, DatabaseDdlKeyInfo>,
            tableComment?: string | null,
            owner?: string | null,
        ): string {
            const qualifiedTableName = formatQualifiedName(schema, tableName);
            const columnClauses = columns.map((column) => {
                const parts = [formatIdentifierForSql(column.name, 'postgresql'), column.fullTypeName];
                if (column.notNull) {
                    parts.push('NOT NULL');
                }
                if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue !== '') {
                    parts.push(`DEFAULT ${column.defaultValue}`);
                }
                return parts.join(' ');
            });
            const definitionLines = [...columnClauses, ...buildConstraintClauses(keysInfo)];
            const statements = [`CREATE TABLE ${qualifiedTableName} (\n    ${definitionLines.join(',\n    ')}\n)\n;`];

            if (tableComment && tableComment.trim().length > 0) {
                statements.push(`COMMENT ON TABLE ${qualifiedTableName} IS ${quoteLiteral(tableComment)};`);
            }

            if (owner && owner.trim().length > 0) {
                statements.push(
                    `ALTER TABLE ${qualifiedTableName} OWNER TO ${formatIdentifierForSql(owner, 'postgresql')};`,
                );
            }

            return statements.join('\n');
        },
        async generateViewDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            viewName: string,
        ): Promise<string> {
            const rows = await executeDatabaseQuery<TextRow>(connection, buildViewDefinitionQuery(schema, viewName));
            const viewSql = rows[0]?.VIEW_SQL?.trim();
            const viewKind = rows[0]?.VIEW_KIND?.trim().toUpperCase() === 'MATERIALIZED VIEW'
                ? 'MATERIALIZED VIEW'
                : 'VIEW';
            if (!viewSql) {
                throw new Error(`PostgreSQL did not return view text for ${schema}.${viewName}.`);
            }

            return ensureStatementTerminated(viewKind === 'MATERIALIZED VIEW'
                ? `CREATE MATERIALIZED VIEW ${formatQualifiedName(schema, viewName)} AS\n${viewSql}`
                : `CREATE OR REPLACE VIEW ${formatQualifiedName(schema, viewName)} AS\n${viewSql}`);
        },
        async generateProcedureDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            procSignature: string,
        ): Promise<string> {
            return generateRoutineDdl(connection, schema, procSignature, 'PROCEDURE');
        },
        async generateExternalTableDDL(): Promise<string> {
            throw new Error('PostgreSQL external table DDL is not supported by this optional extension.');
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('PostgreSQL does not support synonyms.');
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            const connection = await createConnectionFromDetails(options.connectionDetails, options.database);
            try {
                const requestedTypes = (
                    options.objectTypes && options.objectTypes.length > 0
                        ? options.objectTypes
                        : ['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'SEQUENCE']
                ).map((type) => type.trim().toUpperCase());
                const ddlBlocks: string[] = [];
                const errors: string[] = [];
                let skipped = 0;

                for (const objectType of requestedTypes) {
                    if (!SUPPORTED_BATCH_TYPES.has(objectType)) {
                        skipped++;
                        errors.push(`Unsupported PostgreSQL DDL batch object type: ${objectType}`);
                        continue;
                    }

                    const rows = await executeDatabaseQuery<ObjectRow>(connection, buildObjectTypeQuery(objectType));
                    const filteredRows = rows.filter((row) => {
                        if (
                            options.schema &&
                            row.SCHEMA?.trim().toUpperCase() !== options.schema.trim().toUpperCase()
                        ) {
                            return false;
                        }
                        return !!row.OBJNAME && !!row.SCHEMA;
                    });

                    for (const row of filteredRows) {
                        try {
                            const schema = row.SCHEMA!.trim();
                            const objectName = row.OBJNAME!.trim();
                            let ddlCode = '';

                            if (objectType === 'TABLE') {
                                ddlCode = await this.generateTableDDL(connection, options.database, schema, objectName);
                            } else if (objectType === 'VIEW') {
                                ddlCode = await this.generateViewDDL(connection, options.database, schema, objectName);
                            } else if (objectType === 'FUNCTION') {
                                ddlCode = await generateRoutineDdl(connection, schema, objectName, 'FUNCTION');
                            } else if (objectType === 'PROCEDURE') {
                                ddlCode = await this.generateProcedureDDL(
                                    connection,
                                    options.database,
                                    schema,
                                    objectName,
                                );
                            } else if (objectType === 'SEQUENCE') {
                                ddlCode = await generateSequenceDdl(connection, schema, objectName);
                            }

                            if (ddlCode.trim().length > 0) {
                                ddlBlocks.push(ddlCode);
                            }
                        } catch (error) {
                            errors.push(
                                `${objectType} ${row.SCHEMA}.${row.OBJNAME}: ${error instanceof Error ? error.message : String(error)}`,
                            );
                        }
                    }
                }

                return {
                    success: ddlBlocks.length > 0 && errors.length === 0,
                    ddlCode: ddlBlocks.join('\n\n'),
                    objectCount: ddlBlocks.length,
                    errors,
                    skipped,
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
            objectType: string,
        ): Promise<DatabaseDdlResult> {
            const connection = await createConnectionFromDetails(connectionDetails, database);
            try {
                const normalizedObjectType = objectType.trim().toUpperCase();
                const resolvedSchema = await resolveSchemaIfMissing(
                    connection,
                    schema,
                    objectName,
                    normalizedObjectType,
                );

                let ddlCode: string;
                if (normalizedObjectType === 'TABLE') {
                    ddlCode = await this.generateTableDDL(connection, database, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'VIEW') {
                    ddlCode = await this.generateViewDDL(connection, database, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'FUNCTION') {
                    ddlCode = await generateRoutineDdl(connection, resolvedSchema, objectName, 'FUNCTION');
                } else if (normalizedObjectType === 'PROCEDURE') {
                    ddlCode = await this.generateProcedureDDL(connection, database, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'SEQUENCE') {
                    ddlCode = await generateSequenceDdl(connection, resolvedSchema, objectName);
                } else {
                    return {
                        success: false,
                        error: `PostgreSQL DDL generation is not supported for object type "${objectType}".`,
                    };
                }

                return {
                    success: true,
                    ddlCode,
                    objectInfo: {
                        database,
                        schema: resolvedSchema,
                        objectName,
                        objectType: normalizedObjectType,
                    },
                    note: 'Generated from PostgreSQL catalog metadata in the connected database.',
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            } finally {
                await connection.close();
            }
        },
    },
};
