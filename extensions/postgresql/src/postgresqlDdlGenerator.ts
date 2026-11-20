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
import type { ConnectionDetails } from '@justybase/contracts';
import { activateCoreExtension } from '@justybase/vscode-companion-adapter';
import { executeDatabaseQuery } from '@justybase/database-utils/query';
import { formatIdentifierForSql } from '@justybase/dialect-utils/identifierUtils';
import { PostgreSqlConnection } from './postgresqlConnection';
import { postgresqlImportTypeMapper } from './postgresqlImportTypeMapper';
import { postgresqlMaintenanceProvider } from './postgresqlMaintenanceProvider';
import { postgresqlCopilotReferenceProvider } from './postgresqlReferenceProvider';
import { postgresqlSessionMonitorProvider } from './postgresqlSessionMonitorProvider';
import { postgresqlTuningAdvisor } from './postgresqlTuningAdvisor';
import { postgresqlExplainProvider } from './postgresqlExplainParser';
import {
    buildDdlColumnsQuery,
    buildFindTableSchemaQuery,
    buildForeignTableColumnOptionsQuery,
    buildForeignTableDefinitionQuery,
    buildIndexDefinitionQuery,
    buildKeysInfoQuery,
    buildObjectTypeQuery,
    buildRoutineDefinitionQuery,
    buildSequenceDefinitionQuery,
    buildTableCommentQuery,
    buildTableDefinitionQuery,
    buildTableIndexesQuery,
    buildTableOwnerQuery,
    buildTablePartitionsQuery,
    buildTableSerialSequencesQuery,
    buildTableTriggersQuery,
    buildTriggerDefinitionQuery,
    buildViewDefinitionQuery,
} from './postgresqlSystemQueries';

interface ColumnRow {
    ATTNAME?: string;
    FULL_TYPE?: string;
    DESCRIPTION?: string | null;
    IS_NOT_NULL?: number | string | boolean;
    COLDEFAULT?: string | null;
    ATTIDENTITY?: string | null;
    ATTGENERATED?: string | null;
    IDENTITY_OPTIONS?: string | null;
    COLLATION?: string | null;
    STORAGE?: string | null;
    COMPRESSION?: string | null;
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
    SERVER_NAME?: string | null;
    TABLE_OPTIONS?: unknown;
    TABLE_NAME?: string | null;
    VIEW_KIND?: string | null;
    VIEW_SQL?: string | null;
    ROUTINE_DDL?: string | null;
    SEQUENCE_DDL?: string | null;
    INDEX_DDL?: string | null;
    TRIGGER_DDL?: string | null;
    PARTITION_KEY?: string | null;
    PARTITION_DDL?: string | null;
    PERSISTENCE?: string | null;
    ACCESS_METHOD?: string | null;
    TABLESPACE?: string | null;
    RELOPTIONS?: unknown;
    ATTNAME?: string | null;
    SEQUENCE_SCHEMA?: string | null;
    SEQUENCE_NAME?: string | null;
}

interface ObjectRow {
    OBJNAME?: string | null;
    SCHEMA?: string | null;
}

const SUPPORTED_BATCH_TYPES = new Set(['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE', 'FUNCTION', 'PROCEDURE', 'SEQUENCE', 'TRIGGER', 'INDEX']);

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
    const api = await activateCoreExtension();
    if (api.createConnectedDatabaseConnectionFromDetails) {
        return await api.createConnectedDatabaseConnectionFromDetails(
            { ...connectionDetails, dbType: 'postgresql' },
            databaseOverride,
        );
    }

    if (connectionDetails.tunnel) {
        throw new Error(
            'The installed JustyBase core extension cannot open tunneled database connections. Update the core extension and try again.',
        );
    }

    // Keep direct DDL generation usable with an older core that predates
    // the optional connected-profile API. Tunneled profiles must go through
    // core so their loopback listener and SecretStorage token are managed.
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
    return rows.map((row) => {
        const generated = row.ATTGENERATED === 's' || row.ATTGENERATED === 'v';
        return {
            name: row.ATTNAME || '',
            description: row.DESCRIPTION ?? null,
            fullTypeName: row.FULL_TYPE || '',
            notNull: normalizeBooleanFlag(row.IS_NOT_NULL),
            defaultValue: row.COLDEFAULT ?? null,
            identity: row.ATTIDENTITY === 'a'
                ? 'ALWAYS'
                : row.ATTIDENTITY === 'd'
                    ? 'BY DEFAULT'
                    : undefined,
            identityOptions: row.IDENTITY_OPTIONS ?? null,
            generatedExpression: generated ? row.COLDEFAULT ?? null : null,
            generatedKind: row.ATTGENERATED === 'v' ? 'VIRTUAL' : generated ? 'STORED' : undefined,
            collation: row.COLLATION ?? null,
            storage: normalizeColumnStorage(row.STORAGE),
            compression: row.COMPRESSION ?? null,
        };
    });
}

function normalizeColumnStorage(value: string | null | undefined): DatabaseDdlColumnInfo['storage'] {
    switch ((value || '').toUpperCase()) {
        case 'PLAIN':
        case 'EXTERNAL':
        case 'EXTENDED':
        case 'MAIN':
            return (value || '').toUpperCase() as NonNullable<DatabaseDdlColumnInfo['storage']>;
        default:
            return null;
    }
}

function normalizeReloptions(value: unknown): string[] | undefined {
    const options = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : typeof value === 'string' && value.length > 0
            ? value.replace(/^\{|\}$/g, '').split(',').map(item => item.trim()).filter(Boolean)
            : [];
    return options.length > 0 ? options : undefined;
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

async function generateIndexDdl(
    connection: DatabaseConnection,
    schema: string,
    indexName: string,
): Promise<string> {
    const rows = await executeDatabaseQuery<TextRow>(connection, buildIndexDefinitionQuery(schema, indexName));
    const ddl = rows[0]?.INDEX_DDL?.trim();
    if (!ddl) {
        throw new Error(`PostgreSQL did not return DDL for index ${schema}.${indexName}.`);
    }

    return ensureStatementTerminated(ddl);
}

async function generateTriggerDdl(
    connection: DatabaseConnection,
    schema: string,
    triggerName: string,
): Promise<string> {
    const rows = await executeDatabaseQuery<TextRow>(connection, buildTriggerDefinitionQuery(schema, triggerName));
    if (rows.length === 0 || !rows[0]?.TRIGGER_DDL?.trim()) {
        throw new Error(`PostgreSQL did not return DDL for trigger ${schema}.${triggerName}.`);
    }
    if (rows.length > 1) {
        const tables = rows.map(row => row.TABLE_NAME).filter(Boolean).join(', ');
        throw new Error(
            `Trigger ${triggerName} exists on more than one table in schema ${schema} (${tables}). Regenerate DDL from the parent table.`,
        );
    }

    return ensureStatementTerminated(rows[0].TRIGGER_DDL!.trim());
}

/** Parses a PostgreSQL text[] option list (already decoded to strings) into `key 'value'` clauses. */
function formatOptionClauses(options: unknown): string[] {
    const entries = Array.isArray(options) ? options : [];
    return entries
        .map(entry => String(entry))
        .map(entry => {
            const separator = entry.indexOf('=');
            if (separator < 0) {
                return null;
            }
            const key = entry.slice(0, separator).trim();
            const value = entry.slice(separator + 1);
            if (!key) {
                return null;
            }
            return `${formatIdentifierForSql(key, 'postgresql')} ${quoteLiteral(value)}`;
        })
        .filter((clause): clause is string => clause !== null);
}

async function generateForeignTableDdl(
    connection: DatabaseConnection,
    schema: string,
    tableName: string,
): Promise<string> {
    const defRows = await executeDatabaseQuery<TextRow & { SERVER_NAME?: string | null; TABLE_OPTIONS?: unknown }>(
        connection,
        buildForeignTableDefinitionQuery(schema, tableName),
    );
    const definition = defRows[0];
    if (!definition?.SERVER_NAME) {
        throw new Error(`PostgreSQL did not return a foreign table definition for ${schema}.${tableName}.`);
    }

    const columnRows = await executeDatabaseQuery<ColumnRow>(connection, buildDdlColumnsQuery(schema, tableName));
    if (columnRows.length === 0) {
        throw new Error(`Foreign table ${schema}.${tableName} was not found or has no columns.`);
    }
    const optionRows = await executeDatabaseQuery<TextRow & { ATTNAME?: string | null; COLUMN_OPTIONS?: unknown }>(
        connection,
        buildForeignTableColumnOptionsQuery(schema, tableName),
    );
    const columnOptions = new Map<string, string[]>();
    for (const row of optionRows) {
        if (row.ATTNAME) {
            columnOptions.set(row.ATTNAME, formatOptionClauses(row.COLUMN_OPTIONS));
        }
    }

    const columnClauses = rowsToDdlColumns(columnRows).map(column => {
        const parts = [formatIdentifierForSql(column.name, 'postgresql'), column.fullTypeName];
        const options = columnOptions.get(column.name);
        if (options && options.length > 0) {
            parts.push(`OPTIONS (${options.join(', ')})`);
        }
        if (column.notNull) {
            parts.push('NOT NULL');
        }
        if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue !== '') {
            parts.push(`DEFAULT ${column.defaultValue}`);
        }
        return parts.join(' ');
    });

    const qualifiedTableName = formatQualifiedName(schema, tableName);
    const tableOptions = formatOptionClauses(definition.TABLE_OPTIONS);
    const statements = [
        `CREATE FOREIGN TABLE ${qualifiedTableName} (\n    ${columnClauses.join(',\n    ')}\n) SERVER ${formatIdentifierForSql(definition.SERVER_NAME, 'postgresql')}${tableOptions.length > 0 ? `\nOPTIONS (${tableOptions.join(', ')})` : ''}\n;`,
    ];
    if (definition.DESCRIPTION && definition.DESCRIPTION.trim().length > 0) {
        statements.push(`COMMENT ON FOREIGN TABLE ${qualifiedTableName} IS ${quoteLiteral(definition.DESCRIPTION)};`);
    }
    if (definition.OWNER && definition.OWNER.trim().length > 0) {
        statements.push(`ALTER FOREIGN TABLE ${qualifiedTableName} OWNER TO ${formatIdentifierForSql(definition.OWNER, 'postgresql')};`);
    }
    // Local CHECK / NOT VALID constraints and the referenced server definition are
    // intentionally out of scope; the server must already exist in the target database.
    return statements.join('\n');
}

export const postgresqlAdvancedFeatures: DatabaseAdvancedFeatures = {
    explain: postgresqlExplainProvider,
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
        async getTableDefinitionMetadata(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string,
        ): Promise<DatabaseTableDefinitionMetadata | null> {
            const rows = await executeDatabaseQuery<TextRow>(connection, buildTableDefinitionQuery(schema, tableName));
            const row = rows[0];
            if (!row) {
                return null;
            }
            return {
                engine: row.ACCESS_METHOD || 'heap',
                persistence: row.PERSISTENCE === 'u'
                    ? 'unlogged'
                    : row.PERSISTENCE === 't'
                        ? 'temporary'
                        : 'permanent',
                accessMethod: row.ACCESS_METHOD || null,
                tablespace: row.TABLESPACE || null,
                reloptions: normalizeReloptions(row.RELOPTIONS),
                partitionBy: row.PARTITION_KEY?.trim() || undefined,
            };
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
            const tableDefinition = await this.getTableDefinitionMetadata!(
                connection,
                database,
                schema,
                tableName,
            );

            const ddl = this.buildTableDDLFromCache(
                database,
                schema,
                tableName,
                columns,
                [],
                [],
                keysInfo,
                tableComment,
                owner,
                tableDefinition ?? undefined,
            );

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
            const serialRows = await executeDatabaseQuery<TextRow>(
                connection,
                buildTableSerialSequencesQuery(schema, tableName),
            );

            const qualifiedTableName = formatQualifiedName(schema, tableName);
            const sequenceCreates = serialRows
                .map((row) => ensureStatementTerminated(row.SEQUENCE_DDL?.trim() || ''))
                .filter(Boolean);
            const sequenceOwners = serialRows
                .filter((row) => row.ATTNAME && row.SEQUENCE_SCHEMA && row.SEQUENCE_NAME)
                .map((row) => (
                    `ALTER SEQUENCE ${formatQualifiedName(row.SEQUENCE_SCHEMA!, row.SEQUENCE_NAME!)} `
                    + `OWNED BY ${qualifiedTableName}.${formatIdentifierForSql(row.ATTNAME!, 'postgresql')};`
                ));

            const extraStatements = [
                ...indexRows.map((row) => ensureStatementTerminated(row.INDEX_DDL?.trim() || '')).filter(Boolean),
                ...triggerRows.map((row) => ensureStatementTerminated(row.TRIGGER_DDL?.trim() || '')).filter(Boolean),
                ...partitionRows
                    .map((row) => ensureStatementTerminated(row.PARTITION_DDL?.trim() || ''))
                    .filter(Boolean),
            ];

            return [...sequenceCreates, ddl, ...extraStatements, ...sequenceOwners].filter(Boolean).join('\n\n');
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
            tableDefinition?: DatabaseTableDefinitionMetadata,
        ): string {
            const qualifiedTableName = formatQualifiedName(schema, tableName);
            const columnClauses = columns.map((column) => {
                const parts = [formatIdentifierForSql(column.name, 'postgresql'), column.fullTypeName];
                if (column.storage) {
                    parts.push(`STORAGE ${column.storage}`);
                }
                if (column.compression) {
                    parts.push(`COMPRESSION ${column.compression}`);
                }
                if (column.collation) {
                    parts.push(`COLLATE ${column.collation}`);
                }
                if (column.identity) {
                    parts.push(`GENERATED ${column.identity} AS IDENTITY${column.identityOptions ?? ''}`);
                } else if (column.generatedExpression) {
                    const kind = column.generatedKind === 'VIRTUAL' ? 'VIRTUAL' : 'STORED';
                    parts.push(`GENERATED ALWAYS AS (${column.generatedExpression}) ${kind}`);
                } else if (column.defaultValue !== null && column.defaultValue !== undefined && column.defaultValue !== '') {
                    parts.push(`DEFAULT ${column.defaultValue}`);
                }
                if (column.notNull) {
                    parts.push('NOT NULL');
                }
                return parts.join(' ');
            });
            const definitionLines = [...columnClauses, ...buildConstraintClauses(keysInfo)];
            const createTable = tableDefinition?.persistence === 'unlogged'
                ? 'CREATE UNLOGGED TABLE'
                : tableDefinition?.persistence === 'temporary'
                    ? 'CREATE TEMPORARY TABLE'
                    : 'CREATE TABLE';
            const tableOptions: string[] = [];
            if (tableDefinition?.partitionBy?.trim()) {
                tableOptions.push(`PARTITION BY ${tableDefinition.partitionBy.trim()}`);
            }
            if (tableDefinition?.accessMethod && tableDefinition.accessMethod.toLowerCase() !== 'heap') {
                tableOptions.push(`USING ${formatIdentifierForSql(tableDefinition.accessMethod, 'postgresql')}`);
            }
            if (tableDefinition?.reloptions?.length) {
                tableOptions.push(`WITH (${tableDefinition.reloptions.join(', ')})`);
            }
            if (tableDefinition?.tablespace?.trim()) {
                tableOptions.push(`TABLESPACE ${formatIdentifierForSql(tableDefinition.tablespace, 'postgresql')}`);
            }
            const tableOptionsSuffix = tableOptions.length > 0 ? `\n${tableOptions.join('\n')}` : '';
            const statements = [
                `${createTable} ${qualifiedTableName} (\n    ${definitionLines.join(',\n    ')}\n)${tableOptionsSuffix}\n;`,
            ];

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
                        : ['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'FOREIGN TABLE', 'FUNCTION', 'PROCEDURE', 'SEQUENCE']
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
                            } else if (objectType === 'MATERIALIZED VIEW') {
                                ddlCode = await this.generateViewDDL(connection, options.database, schema, objectName);
                            } else if (objectType === 'FOREIGN TABLE') {
                                ddlCode = await generateForeignTableDdl(connection, schema, objectName);
                            } else if (objectType === 'TRIGGER') {
                                ddlCode = await generateTriggerDdl(connection, schema, objectName);
                            } else if (objectType === 'INDEX') {
                                ddlCode = await generateIndexDdl(connection, schema, objectName);
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
                } else if (normalizedObjectType === 'VIEW' || normalizedObjectType === 'MATERIALIZED VIEW') {
                    ddlCode = await this.generateViewDDL(connection, database, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'FOREIGN TABLE') {
                    ddlCode = await generateForeignTableDdl(connection, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'TRIGGER') {
                    ddlCode = await generateTriggerDdl(connection, resolvedSchema, objectName);
                } else if (normalizedObjectType === 'INDEX') {
                    ddlCode = await generateIndexDdl(connection, resolvedSchema, objectName);
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
