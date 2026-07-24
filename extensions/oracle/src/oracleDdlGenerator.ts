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
import { OracleConnection } from './oracleConnection';
import {
    buildBatchObjectListQuery,
    buildColumnMetadataQuery,
    buildDdlQuery,
    buildFindTableSchemaQuery,
    buildIndexObjectListQuery,
    buildKeysInfoQuery,
    buildObjectGrantsQuery,
    buildPartitionedTableListQuery,
    buildRoutineSourceQuery,
    buildTableCommentQuery,
    buildTableStatsQuery,
    buildViewDefinitionQuery,
    mapObjectTypeToDbmsMetadataType
} from './oracleSystemQueries';

interface DdlRow {
    DDL?: string | null;
}

interface ColumnRow {
    ATTNAME?: string;
    FULL_TYPE?: string;
    FORMAT_TYPE?: string;
    DESCRIPTION?: string | null;
    IS_NOT_NULL?: number | string | boolean;
    COLDEFAULT?: string | null;
}

interface KeyRow {
    CONSTNAME?: string;
    TYPE?: string;
    TYPECHAR?: string;
    COLNAME?: string;
    PKSCHEMA?: string;
    PKRELATION?: string;
    PKCOLNAME?: string;
    DELETERULE?: string;
    UPDATERULE?: string;
    ENFORCED?: string | null;
    TRUSTED?: string | null;
    REMARKS?: string | null;
}

interface TextValueRow {
    DESCRIPTION?: string | null;
    VIEW_TEXT?: string | null;
}

interface SourceRow {
    SOURCE_LINE?: string | null;
}

interface ObjectRow {
    OBJECT_SCHEMA?: string | null;
    OBJECT_NAME?: string | null;
    OBJECT_TYPE?: string | null;
}

interface IndexRow extends ObjectRow {
    TABLE_NAME?: string | null;
}

interface GrantRow {
    OBJECT_SCHEMA?: string | null;
    OBJECT_NAME?: string | null;
    GRANTEE?: string | null;
    PRIVILEGE?: string | null;
    GRANTABLE?: string | null;
    COLUMN_NAME?: string | null;
}

const ROUTINE_SOURCE_TYPES = new Set(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER']);
type OracleDdlProvider = NonNullable<DatabaseAdvancedFeatures['ddl']>;

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function normalizeBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 't' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }

    return false;
}

function ensureStatementTerminated(statement: string): string {
    const trimmed = statement.trim();
    if (!trimmed) {
        return trimmed;
    }

    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function buildQualifiedOracleName(schema: string | undefined, objectName: string): string {
    const formattedObjectName = formatIdentifierForSql(objectName, 'oracle');
    if (!schema) {
        return formattedObjectName;
    }

    return `${formatIdentifierForSql(schema, 'oracle')}.${formattedObjectName}`;
}

function buildColumnDefinition(column: DatabaseDdlColumnInfo): string {
    const parts = [formatIdentifierForSql(column.name, 'oracle'), column.fullTypeName];
    if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue.trim().length > 0) {
        parts.push(`DEFAULT ${column.defaultValue.trim()}`);
    }
    if (column.notNull) {
        parts.push('NOT NULL');
    }
    return parts.join(' ');
}

function buildConstraintClauses(keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const clauses: string[] = [];

    for (const [constraintName, keyInfo] of keysInfo) {
        const columns = keyInfo.columns.map(column => formatIdentifierForSql(column, 'oracle')).join(', ');
        if (!columns) {
            continue;
        }

        const constraintPrefix = constraintName
            ? `CONSTRAINT ${formatIdentifierForSql(constraintName, 'oracle')} `
            : '';
        const normalizedTypeChar = (keyInfo.typeChar || '').trim().toUpperCase();

        if (normalizedTypeChar === 'P') {
            clauses.push(`${constraintPrefix}PRIMARY KEY (${columns})`);
            continue;
        }

        if (normalizedTypeChar === 'U') {
            clauses.push(`${constraintPrefix}UNIQUE (${columns})`);
            continue;
        }

        if (normalizedTypeChar === 'R') {
            const referencedRelation = keyInfo.pkRelation ? buildQualifiedOracleName(keyInfo.pkSchema || undefined, keyInfo.pkRelation) : undefined;
            const referencedColumns = keyInfo.pkColumns.map(column => formatIdentifierForSql(column, 'oracle')).join(', ');
            if (!referencedRelation || !referencedColumns) {
                continue;
            }

            const parts = [
                `${constraintPrefix}FOREIGN KEY (${columns}) REFERENCES ${referencedRelation} (${referencedColumns})`
            ];
            const deleteRule = (keyInfo.deleteType || '').trim().toUpperCase();
            if (deleteRule === 'CASCADE') {
                parts.push('ON DELETE CASCADE');
            } else if (deleteRule === 'SET NULL') {
                parts.push('ON DELETE SET NULL');
            }
            clauses.push(parts.join(' '));
        }
    }

    return clauses;
}

function buildCommentStatements(
    schema: string,
    tableName: string,
    columns: readonly DatabaseDdlColumnInfo[],
    tableComment?: string | null
): string[] {
    const qualifiedTableName = buildQualifiedOracleName(schema, tableName);
    const statements: string[] = [];

    if (tableComment && tableComment.trim().length > 0) {
        statements.push(`COMMENT ON TABLE ${qualifiedTableName} IS '${escapeSqlLiteral(tableComment.trim())}';`);
    }

    for (const column of columns) {
        if (!column.description || column.description.trim().length === 0) {
            continue;
        }

        statements.push(
            `COMMENT ON COLUMN ${qualifiedTableName}.${formatIdentifierForSql(column.name, 'oracle')} IS '${escapeSqlLiteral(column.description.trim())}';`
        );
    }

    return statements;
}

function extractRoutineBaseName(objectName: string): string {
    const signatureStart = objectName.indexOf('(');
    return (signatureStart >= 0 ? objectName.slice(0, signatureStart) : objectName).trim();
}

function isSupportedObjectType(objectType: string): boolean {
    const normalizedType = objectType.trim().toUpperCase();
    return normalizedType === 'TABLE'
        || normalizedType === 'VIEW'
        || normalizedType === 'PROCEDURE'
        || normalizedType === 'FUNCTION'
        || normalizedType === 'PACKAGE'
        || normalizedType === 'PACKAGE BODY'
        || normalizedType === 'SEQUENCE'
        || normalizedType === 'SYNONYM'
        || normalizedType === 'TRIGGER'
        || normalizedType === 'INDEX';
}

async function createConnectionFromDetails(connectionDetails: ConnectionDetails): Promise<DatabaseConnection> {
    const connection = new OracleConnection({
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

async function prepareDbmsMetadataSession(connection: DatabaseConnection): Promise<void> {
    const command = connection.createCommand(`
        BEGIN
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
            DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
        END;
    `);

    try {
        await command.execute();
    } catch {
        // DBMS_METADATA transforms are best-effort. A plain GET_DDL call can still succeed.
    }
}

async function getDbmsMetadataDdl(
    connection: DatabaseConnection,
    schema: string,
    objectName: string,
    objectType: string
): Promise<string> {
    await prepareDbmsMetadataSession(connection);
    const rows = await executeDatabaseQuery<DdlRow>(connection, buildDdlQuery(objectType, schema, objectName));
    const ddl = rows[0]?.DDL?.trim();
    if (!ddl) {
        throw new Error(`Oracle DBMS_METADATA did not return DDL for ${objectType} ${schema}.${objectName}.`);
    }

    return ensureStatementTerminated(ddl);
}

async function getRoutineSourceDdl(
    connection: DatabaseConnection,
    schema: string,
    objectName: string,
    sourceType: string
): Promise<string> {
    const rows = await executeDatabaseQuery<SourceRow>(connection, buildRoutineSourceQuery(schema, objectName, sourceType));
    const source = rows.map(row => row.SOURCE_LINE ?? '').join('').trim();
    if (!source) {
        throw new Error(`Oracle source text is unavailable for ${sourceType} ${schema}.${objectName}.`);
    }

    return ensureStatementTerminated(source);
}

async function getViewFallbackDdl(connection: DatabaseConnection, schema: string, viewName: string): Promise<string> {
    const rows = await executeDatabaseQuery<TextValueRow>(connection, buildViewDefinitionQuery(schema, viewName));
    const viewText = rows[0]?.VIEW_TEXT?.trim();
    if (!viewText) {
        throw new Error(`Oracle view text is unavailable for ${schema}.${viewName}.`);
    }

    return ensureStatementTerminated(
        `CREATE OR REPLACE VIEW ${buildQualifiedOracleName(schema, viewName)} AS\n${viewText}`
    );
}

async function generateRoutineLikeDdl(
    connection: DatabaseConnection,
    schema: string,
    objectName: string,
    objectType: string
): Promise<string> {
    const baseName = extractRoutineBaseName(objectName);
    try {
        return await getDbmsMetadataDdl(connection, schema, baseName, objectType);
    } catch {
        if (ROUTINE_SOURCE_TYPES.has(objectType.trim().toUpperCase())) {
            return getRoutineSourceDdl(connection, schema, baseName, objectType.trim().toUpperCase());
        }
        throw new Error(`Oracle object type "${objectType}" does not have a supported source fallback.`);
    }
}

async function generateObjectDdl(
    provider: OracleDdlProvider,
    connection: DatabaseConnection,
    database: string,
    schema: string,
    objectName: string,
    objectType: string
): Promise<string> {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE') {
        return provider.generateTableDDL(connection, database, schema, objectName);
    }
    if (normalizedType === 'VIEW') {
        return provider.generateViewDDL(connection, database, schema, objectName);
    }
    if (normalizedType === 'PROCEDURE') {
        return provider.generateProcedureDDL(connection, database, schema, objectName);
    }
    if (normalizedType === 'FUNCTION' || normalizedType === 'PACKAGE' || normalizedType === 'PACKAGE BODY' || normalizedType === 'TRIGGER') {
        return generateRoutineLikeDdl(connection, schema, objectName, normalizedType);
    }
    if (normalizedType === 'SEQUENCE' || normalizedType === 'SYNONYM') {
        return getDbmsMetadataDdl(connection, schema, objectName, normalizedType);
    }
    if (normalizedType === 'INDEX') {
        return getDbmsMetadataDdl(connection, schema, objectName, 'INDEX');
    }

    throw new Error(`Oracle DDL generation is not implemented for object type "${objectType}".`);
}

function objectTypeOrder(objectType: string): number {
    const order: Record<string, number> = {
        SEQUENCE: 10,
        TABLE: 20,
        INDEX: 30,
        VIEW: 40,
        PACKAGE: 50,
        'PACKAGE BODY': 60,
        FUNCTION: 70,
        PROCEDURE: 80,
        TRIGGER: 90,
        SYNONYM: 100,
    };
    return order[objectType] ?? 1000;
}

function buildGrantDdl(row: GrantRow): string {
    const schema = row.OBJECT_SCHEMA?.trim();
    const objectName = row.OBJECT_NAME?.trim();
    const grantee = row.GRANTEE?.trim();
    const privilege = row.PRIVILEGE?.trim().toUpperCase();
    if (!schema || !objectName || !grantee || !privilege) {
        throw new Error('Oracle grant metadata is incomplete.');
    }

    const qualifiedObject = buildQualifiedOracleName(schema, objectName);
    const column = row.COLUMN_NAME?.trim()
        ? ` (${formatIdentifierForSql(row.COLUMN_NAME.trim(), 'oracle')})`
        : '';
    const formattedGrantee = grantee.toUpperCase() === 'PUBLIC'
        ? 'PUBLIC'
        : formatIdentifierForSql(grantee, 'oracle');
    const grantOption = String(row.GRANTABLE ?? '').trim().toUpperCase() === 'YES'
        ? ' WITH GRANT OPTION'
        : '';

    return `GRANT ${privilege}${column} ON ${qualifiedObject} TO ${formattedGrantee}${grantOption};`;
}

const oracleDdlProvider: OracleDdlProvider = {
    quoteNameIfNeeded(name: string): string {
        return formatIdentifierForSql(name, 'oracle');
    },
    buildFindTableSchemaQuery(_database: string, tableName: string): string {
        return buildFindTableSchemaQuery(tableName);
    },
    buildTableStatsQuery(_database: string, schema: string, tableName: string): string {
        return buildTableStatsQuery(schema, tableName);
    },
    buildSkewCheckQuery(qualifiedTableName: string): string {
        void qualifiedTableName;
        throw new Error('Oracle does not expose Netezza SPU/data-slice skew metrics.');
    },
    async getColumns(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        tableName: string
    ): Promise<DatabaseDdlColumnInfo[]> {
        const rows = await executeDatabaseQuery<ColumnRow>(connection, buildColumnMetadataQuery(schema, tableName));
        return rows.map(row => ({
            name: row.ATTNAME || '',
            description: row.DESCRIPTION || null,
            fullTypeName: row.FULL_TYPE || row.FORMAT_TYPE || 'VARCHAR2',
            notNull: normalizeBooleanFlag(row.IS_NOT_NULL),
            defaultValue: row.COLDEFAULT ? String(row.COLDEFAULT) : null
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
        _database: string,
        schema: string,
        tableName: string
    ): Promise<Map<string, DatabaseDdlKeyInfo>> {
        const rows = await executeDatabaseQuery<KeyRow>(connection, buildKeysInfoQuery(schema, tableName));
        const keysInfo = new Map<string, DatabaseDdlKeyInfo>();

        for (const row of rows) {
            const keyName = row.CONSTNAME || `KEY_${keysInfo.size + 1}`;
            const keyInfo = keysInfo.get(keyName) ?? {
                type: row.TYPE || '',
                typeChar: row.TYPECHAR || '',
                columns: [],
                pkDatabase: null,
                pkSchema: row.PKSCHEMA || null,
                pkRelation: row.PKRELATION || null,
                pkColumns: [],
                updateType: row.UPDATERULE || '',
                deleteType: row.DELETERULE || '',
                enforced: row.ENFORCED || undefined,
                trusted: row.TRUSTED || undefined,
                comment: row.REMARKS || null
            };

            if (row.COLNAME && !keyInfo.columns.includes(row.COLNAME)) {
                keyInfo.columns.push(row.COLNAME);
            }
            if (row.PKCOLNAME && !keyInfo.pkColumns.includes(row.PKCOLNAME)) {
                keyInfo.pkColumns.push(row.PKCOLNAME);
            }

            keysInfo.set(keyName, keyInfo);
        }

        return keysInfo;
    },
    async getTableComment(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        tableName: string
    ): Promise<string | null> {
        const rows = await executeDatabaseQuery<TextValueRow>(connection, buildTableCommentQuery(schema, tableName));
        const description = rows[0]?.DESCRIPTION?.trim();
        return description && description.length > 0 ? description : null;
    },
    async getTableOwner(
        _connection: DatabaseConnection,
        _database: string,
        schema: string
    ): Promise<string | null> {
        return schema || null;
    },
    async generateTableDDL(
        connection: DatabaseConnection,
        database: string,
        schema: string,
        tableName: string
    ): Promise<string> {
        try {
            return await getDbmsMetadataDdl(connection, schema, tableName, 'TABLE');
        } catch {
            const columns = await this.getColumns(connection, database, schema, tableName);
            const keysInfo = await this.getKeysInfo(connection, database, schema, tableName);
            const tableComment = await this.getTableComment(connection, database, schema, tableName);
            return this.buildTableDDLFromCache(database, schema, tableName, columns, [], [], keysInfo, tableComment, schema);
        }
    },
    buildTableDDLFromCache(
        _database: string,
        schema: string,
        tableName: string,
        columns: DatabaseDdlColumnInfo[],
        _distributionColumns: string[],
        _organizeColumns: string[],
        keysInfo: Map<string, DatabaseDdlKeyInfo>,
        tableComment?: string | null
    ): string {
        const qualifiedTableName = buildQualifiedOracleName(schema, tableName);
        const definitions = [
            ...columns.map(buildColumnDefinition),
            ...buildConstraintClauses(keysInfo)
        ];

        const ddlParts = [
            `CREATE TABLE ${qualifiedTableName} (\n    ${definitions.join(',\n    ')}\n);`
        ];

        const commentStatements = buildCommentStatements(schema, tableName, columns, tableComment);
        if (commentStatements.length > 0) {
            ddlParts.push(commentStatements.join('\n'));
        }

        return ddlParts.join('\n\n');
    },
    async generateViewDDL(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        viewName: string
    ): Promise<string> {
        try {
            return await getDbmsMetadataDdl(connection, schema, viewName, 'VIEW');
        } catch {
            return getViewFallbackDdl(connection, schema, viewName);
        }
    },
    async generateProcedureDDL(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        procSignature: string
    ): Promise<string> {
        return generateRoutineLikeDdl(connection, schema, procSignature, 'PROCEDURE');
    },
    async generateExternalTableDDL(): Promise<string> {
        throw new Error('Oracle external table DDL export is not implemented in this optional extension.');
    },
    async generateSynonymDDL(
        connection: DatabaseConnection,
        _database: string,
        schema: string,
        synonymName: string
    ): Promise<string> {
        return getDbmsMetadataDdl(connection, schema, synonymName, 'SYNONYM');
    },
    async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
        const connection = await createConnectionFromDetails(options.connectionDetails);
        const mode = options.mode ?? 'objects';
        const includeIndexes = options.includeIndexes ?? mode === 'schema-migration';
        const includePartitions = options.includePartitions ?? mode === 'schema-migration';
        const includeGrants = options.includeGrants ?? mode === 'schema-migration';
        try {
            const rows = await executeDatabaseQuery<ObjectRow>(connection, buildBatchObjectListQuery(options.schema, options.objectTypes));
            const generatedStatements: Array<{ order: number; sequence: number; ddl: string }> = [];
            const errors: string[] = [];
            const warnings: string[] = [];
            let skipped = 0;
            let sequence = 0;

            const partitionedTables = new Set<string>();
            if (includePartitions) {
                try {
                    const partitionRows = await executeDatabaseQuery<ObjectRow>(
                        connection,
                        buildPartitionedTableListQuery(options.schema),
                    );
                    for (const row of partitionRows) {
                        const schema = row.OBJECT_SCHEMA?.trim().toUpperCase();
                        const table = row.OBJECT_NAME?.trim().toUpperCase();
                        if (schema && table) {
                            partitionedTables.add(`${schema}.${table}`);
                        }
                    }
                } catch (error: unknown) {
                    errors.push(`Unable to inspect Oracle partition metadata: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            const orderedRows = [...rows].sort((left, right) => {
                const leftType = left.OBJECT_TYPE?.trim().toUpperCase() || '';
                const rightType = right.OBJECT_TYPE?.trim().toUpperCase() || '';
                return objectTypeOrder(leftType) - objectTypeOrder(rightType)
                    || String(left.OBJECT_NAME).localeCompare(String(right.OBJECT_NAME));
            });

            const generatedIndexNames = new Set<string>();
            for (const row of orderedRows) {
                const objectSchema = row.OBJECT_SCHEMA?.trim();
                const objectName = row.OBJECT_NAME?.trim();
                const objectType = row.OBJECT_TYPE?.trim().toUpperCase();
                if (!objectSchema || !objectName || !objectType) {
                    skipped += 1;
                    continue;
                }

                if (!isSupportedObjectType(objectType)) {
                    errors.push(`Skipped unsupported Oracle object type "${objectType}" for ${objectSchema}.${objectName}.`);
                    skipped += 1;
                    continue;
                }

                try {
                    const ddl = await generateObjectDdl(this, connection, options.database, objectSchema, objectName, objectType);
                    generatedStatements.push({ order: objectTypeOrder(objectType), sequence: sequence++, ddl });
                    if (objectType === 'INDEX') {
                        generatedIndexNames.add(`${objectSchema.toUpperCase()}.${objectName.toUpperCase()}`);
                    }
                    if (includePartitions && objectType === 'TABLE' && partitionedTables.has(`${objectSchema.toUpperCase()}.${objectName.toUpperCase()}`) && !/\bPARTITION\s+BY\b/i.test(ddl)) {
                        warnings.push(`Partition metadata for ${objectSchema}.${objectName} was not present in the generated table DDL.`);
                    }
                } catch (error) {
                    errors.push(`${objectType} ${objectSchema}.${objectName}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (includeIndexes) {
                try {
                    const indexRows = await executeDatabaseQuery<IndexRow>(connection, buildIndexObjectListQuery(options.schema));
                    for (const row of indexRows) {
                        const objectSchema = row.OBJECT_SCHEMA?.trim();
                        const objectName = row.OBJECT_NAME?.trim();
                        if (!objectSchema || !objectName) {
                            skipped += 1;
                            continue;
                        }

                        const indexKey = `${objectSchema.toUpperCase()}.${objectName.toUpperCase()}`;
                        if (generatedIndexNames.has(indexKey)) {
                            continue;
                        }

                        try {
                            generatedStatements.push({
                                order: objectTypeOrder('INDEX'),
                                sequence: sequence++,
                                ddl: await generateObjectDdl(this, connection, options.database, objectSchema, objectName, 'INDEX'),
                            });
                            generatedIndexNames.add(indexKey);
                        } catch (error) {
                            errors.push(`INDEX ${objectSchema}.${objectName}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                } catch (error: unknown) {
                    errors.push(`Unable to enumerate Oracle indexes: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (includeGrants) {
                try {
                    const grantRows = await executeDatabaseQuery<GrantRow>(connection, buildObjectGrantsQuery(options.schema));
                    for (const row of grantRows) {
                        try {
                            generatedStatements.push({ order: 200, sequence: sequence++, ddl: buildGrantDdl(row) });
                        } catch (error) {
                            errors.push(`GRANT metadata: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                } catch (error: unknown) {
                    errors.push(`Unable to enumerate Oracle object grants: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            const ddlStatements = generatedStatements
                .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
                .map(statement => statement.ddl);

            return {
                success: errors.length === 0 && ddlStatements.length > 0,
                ddlCode: ddlStatements.join('\n\n'),
                objectCount: ddlStatements.length,
                errors,
                skipped,
                warnings: warnings.length > 0 ? warnings : undefined,
                artifactKind: mode,
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
        const normalizedType = objectType.trim().toUpperCase();

        try {
            const ddlCode = await generateObjectDdl(this, connection, database, schema, objectName, normalizedType);
            return {
                success: true,
                ddlCode,
                objectInfo: {
                    database,
                    schema,
                    objectName,
                    objectType
                },
                note: `Oracle DDL was generated using ${mapObjectTypeToDbmsMetadataType(normalizedType)} metadata where available.`
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
import { oracleImportTypeMapper } from './oracleImportTypeMapper';
import { oracleMaintenanceProvider } from './oracleMaintenanceProvider';
import { oracleCopilotReferenceProvider } from './oracleReferenceProvider';
import { oracleSessionMonitorProvider } from './oracleSessionMonitorProvider';
import { oracleTuningAdvisor } from './oracleTuningAdvisor';

export const oracleAdvancedFeatures: DatabaseAdvancedFeatures = {
    ddl: oracleDdlProvider,
    importTypeMapper: oracleImportTypeMapper,
    tuningAdvisor: oracleTuningAdvisor,
    maintenance: oracleMaintenanceProvider,
    copilotReferenceProvider: oracleCopilotReferenceProvider,
    sessionMonitor: oracleSessionMonitorProvider
};
