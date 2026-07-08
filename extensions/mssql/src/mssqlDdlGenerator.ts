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
import { MsSqlConnection } from './mssqlConnection';

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function escapeBracketIdentifier(value: string): string {
    return value.replace(/]/g, ']]');
}

interface MsSqlColumnRow {
    COLUMN_NAME?: string;
    DATA_TYPE?: string;
    CHARACTER_MAXIMUM_LENGTH?: number | null;
    NUMERIC_PRECISION?: number | null;
    NUMERIC_SCALE?: number | null;
    IS_NULLABLE?: string;
    COLUMN_DEFAULT?: string | null;
    ORDINAL_POSITION?: number;
}

interface MsSqlKeyColumnRow {
    CONSTRAINT_NAME?: string;
    CONSTRAINT_TYPE?: string;
    COLUMN_NAME?: string;
    ORDINAL_POSITION?: number;
}

interface MsSqlForeignKeyRow {
    FK_NAME?: string;
    FK_COLUMN?: string;
    PK_TABLE_SCHEMA?: string;
    PK_TABLE_NAME?: string;
    PK_COLUMN?: string;
    UPDATE_RULE?: string;
    DELETE_RULE?: string;
}

interface MsSqlObjectDefinitionRow {
    DEFINITION?: string | null;
}

interface MsSqlTableOwnerRow {
    OWNER?: string;
}

interface MsSqlCommentRow {
    COMMENT?: string | null;
}

function buildFullTypeName(row: MsSqlColumnRow): string {
    const baseType = (row.DATA_TYPE || 'sql_variant').toUpperCase();

    if (
        baseType === 'CHAR' ||
        baseType === 'VARCHAR' ||
        baseType === 'NCHAR' ||
        baseType === 'NVARCHAR' ||
        baseType === 'BINARY' ||
        baseType === 'VARBINARY'
    ) {
        const maxLen = row.CHARACTER_MAXIMUM_LENGTH;
        if (maxLen === -1) {
            return `${baseType}(MAX)`;
        }
        if (maxLen !== null && maxLen !== undefined && maxLen > 0) {
            return `${baseType}(${maxLen})`;
        }
        return baseType;
    }

    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const precision = row.NUMERIC_PRECISION;
        const scale = row.NUMERIC_SCALE;
        if (precision !== null && precision !== undefined) {
            if (scale !== null && scale !== undefined && scale > 0) {
                return `${baseType}(${precision},${scale})`;
            }
            return `${baseType}(${precision})`;
        }
        return baseType;
    }

    if (baseType === 'FLOAT') {
        const precision = row.NUMERIC_PRECISION;
        if (precision !== null && precision !== undefined && precision !== 53) {
            return `${baseType}(${precision})`;
        }
        return baseType;
    }

    if (baseType === 'DATETIME2' || baseType === 'DATETIMEOFFSET' || baseType === 'TIME') {
        const scale = row.NUMERIC_SCALE;
        if (scale !== null && scale !== undefined && scale !== 7) {
            return `${baseType}(${scale})`;
        }
        return baseType;
    }

    return baseType;
}

async function createConnectionFromDetails(
    connectionDetails: ConnectionDetails,
    databaseOverride?: string
): Promise<DatabaseConnection> {
    const connection = new MsSqlConnection({
        host: connectionDetails.host,
        port: connectionDetails.port,
        database: databaseOverride || connectionDetails.database,
        user: connectionDetails.user,
        password: connectionDetails.password,
        options: connectionDetails.options
    });
    await connection.connect();
    return connection;
}

function buildConstraintClauses(keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const constraints: string[] = [];

    for (const [constraintName, keyInfo] of keysInfo) {
        const columns = keyInfo.columns.map((column) => `[${column}]`).join(', ');
        const normalizedType = keyInfo.type.toUpperCase();

        if (
            (keyInfo.typeChar || '').toUpperCase() === 'P' ||
            normalizedType.includes('PRIMARY')
        ) {
            constraints.push(`CONSTRAINT [${constraintName}] PRIMARY KEY (${columns})`);
            continue;
        }

        if (
            (keyInfo.typeChar || '').toUpperCase() === 'U' ||
            normalizedType.includes('UNIQUE')
        ) {
            constraints.push(`CONSTRAINT [${constraintName}] UNIQUE (${columns})`);
            continue;
        }

        if (
            (keyInfo.typeChar || '').toUpperCase() === 'R' ||
            normalizedType.includes('FOREIGN')
        ) {
            const referencedTable = keyInfo.pkRelation
                ? keyInfo.pkSchema
                    ? `[${keyInfo.pkSchema}].[${keyInfo.pkRelation}]`
                    : `[${keyInfo.pkRelation}]`
                : undefined;
            const referencedColumns = keyInfo.pkColumns
                .map((column) => `[${column}]`)
                .join(', ');
            if (!referencedTable || !referencedColumns) {
                continue;
            }
            let fkClause = `CONSTRAINT [${constraintName}] FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})`;
            if (keyInfo.updateType && keyInfo.updateType !== 'NO ACTION') {
                fkClause += ` ON UPDATE ${keyInfo.updateType}`;
            }
            if (keyInfo.deleteType && keyInfo.deleteType !== 'NO ACTION') {
                fkClause += ` ON DELETE ${keyInfo.deleteType}`;
            }
            constraints.push(fkClause);
        }
    }

    return constraints;
}
import { mssqlImportTypeMapper } from './mssqlImportTypeMapper';
import { mssqlMaintenanceProvider } from './mssqlMaintenanceProvider';
import { mssqlCopilotReferenceProvider } from './mssqlReferenceProvider';
import { mssqlSessionMonitorProvider } from './mssqlSessionMonitorProvider';
import { mssqlTuningAdvisor } from './mssqlTuningAdvisor';

export const mssqlAdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: mssqlImportTypeMapper,
    tuningAdvisor: mssqlTuningAdvisor,
    maintenance: mssqlMaintenanceProvider,
    copilotReferenceProvider: mssqlCopilotReferenceProvider,
    sessionMonitor: mssqlSessionMonitorProvider,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return `[${name}]`;
        },
        buildFindTableSchemaQuery(_database: string, tableName: string): string {
            return `SELECT s.name AS SCHEMA_NAME FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE t.name = '${escapeSqlLiteral(tableName)}'`;
        },
        buildTableStatsQuery(
            _database: string,
            schema: string,
            tableName: string
        ): string {
            return `SELECT COUNT(*) AS [ROW_COUNT] FROM [${schema}].[${tableName}]`;
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 1 AS [DATASLICEID], COUNT(*) AS [ROW_COUNT] FROM ${qualifiedTableName}`;
        },

        async getColumns(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<DatabaseDdlColumnInfo[]> {
            const rows = await executeDatabaseQuery<MsSqlColumnRow>(
                connection,
                `
                    SELECT
                        COLUMN_NAME,
                        DATA_TYPE,
                        CHARACTER_MAXIMUM_LENGTH,
                        NUMERIC_PRECISION,
                        NUMERIC_SCALE,
                        IS_NULLABLE,
                        COLUMN_DEFAULT,
                        ORDINAL_POSITION
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = '${escapeSqlLiteral(schema)}'
                      AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
                    ORDER BY ORDINAL_POSITION
                `
            );

            return rows.map((row) => ({
                name: row.COLUMN_NAME || '',
                description: null,
                fullTypeName: buildFullTypeName(row),
                notNull: row.IS_NULLABLE === 'NO',
                defaultValue: row.COLUMN_DEFAULT ?? null
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
            const keysInfo = new Map<string, DatabaseDdlKeyInfo>();

            // Primary keys and unique constraints
            const pkUkRows = await executeDatabaseQuery<MsSqlKeyColumnRow>(
                connection,
                `
                    SELECT
                        tc.CONSTRAINT_NAME,
                        tc.CONSTRAINT_TYPE,
                        kcu.COLUMN_NAME,
                        kcu.ORDINAL_POSITION
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                        AND tc.TABLE_NAME = kcu.TABLE_NAME
                    WHERE tc.TABLE_SCHEMA = '${escapeSqlLiteral(schema)}'
                      AND tc.TABLE_NAME = '${escapeSqlLiteral(tableName)}'
                      AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
                    ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
                `
            );

            for (const row of pkUkRows) {
                const constraintName = row.CONSTRAINT_NAME || '';
                const existing = keysInfo.get(constraintName);
                if (existing) {
                    if (row.COLUMN_NAME) {
                        existing.columns.push(row.COLUMN_NAME);
                    }
                } else {
                    const isPk = (row.CONSTRAINT_TYPE || '').toUpperCase() === 'PRIMARY KEY';
                    keysInfo.set(constraintName, {
                        type: row.CONSTRAINT_TYPE || '',
                        typeChar: isPk ? 'P' : 'U',
                        columns: row.COLUMN_NAME ? [row.COLUMN_NAME] : [],
                        pkDatabase: null,
                        pkSchema: null,
                        pkRelation: null,
                        pkColumns: [],
                        updateType: '',
                        deleteType: ''
                    });
                }
            }

            // Foreign keys
            const fkRows = await executeDatabaseQuery<MsSqlForeignKeyRow>(
                connection,
                `
                    SELECT
                        fk.name AS FK_NAME,
                        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS FK_COLUMN,
                        OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS PK_TABLE_SCHEMA,
                        OBJECT_NAME(fkc.referenced_object_id) AS PK_TABLE_NAME,
                        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS PK_COLUMN,
                        fk.update_referential_action_desc AS UPDATE_RULE,
                        fk.delete_referential_action_desc AS DELETE_RULE
                    FROM sys.foreign_keys fk
                    JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
                    JOIN sys.tables t ON fk.parent_object_id = t.object_id
                    JOIN sys.schemas s ON t.schema_id = s.schema_id
                    WHERE s.name = '${escapeSqlLiteral(schema)}'
                      AND t.name = '${escapeSqlLiteral(tableName)}'
                    ORDER BY fk.name, fkc.constraint_column_id
                `
            );

            for (const row of fkRows) {
                const fkName = row.FK_NAME || '';
                const existing = keysInfo.get(fkName);
                if (existing) {
                    if (row.FK_COLUMN) {
                        existing.columns.push(row.FK_COLUMN);
                    }
                    if (row.PK_COLUMN) {
                        existing.pkColumns.push(row.PK_COLUMN);
                    }
                } else {
                    const updateRule = (row.UPDATE_RULE || 'NO_ACTION').replace(/_/g, ' ');
                    const deleteRule = (row.DELETE_RULE || 'NO_ACTION').replace(/_/g, ' ');
                    keysInfo.set(fkName, {
                        type: 'FOREIGN KEY',
                        typeChar: 'R',
                        columns: row.FK_COLUMN ? [row.FK_COLUMN] : [],
                        pkDatabase: null,
                        pkSchema: row.PK_TABLE_SCHEMA || null,
                        pkRelation: row.PK_TABLE_NAME || null,
                        pkColumns: row.PK_COLUMN ? [row.PK_COLUMN] : [],
                        updateType: updateRule,
                        deleteType: deleteRule
                    });
                }
            }

            return keysInfo;
        },

        async getTableComment(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<MsSqlCommentRow>(
                connection,
                `
                    SELECT CAST(ep.value AS NVARCHAR(MAX)) AS COMMENT
                    FROM sys.extended_properties ep
                    JOIN sys.tables t ON ep.major_id = t.object_id
                    JOIN sys.schemas s ON t.schema_id = s.schema_id
                    WHERE ep.minor_id = 0
                      AND ep.class = 1
                      AND ep.name = 'MS_Description'
                      AND s.name = '${escapeSqlLiteral(schema)}'
                      AND t.name = '${escapeSqlLiteral(tableName)}'
                `
            );
            return rows[0]?.COMMENT ?? null;
        },

        async getTableOwner(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string | null> {
            const rows = await executeDatabaseQuery<MsSqlTableOwnerRow>(
                connection,
                `
                    SELECT dp.name AS OWNER
                    FROM sys.tables t
                    JOIN sys.schemas s ON t.schema_id = s.schema_id
                    JOIN sys.database_principals dp ON s.principal_id = dp.principal_id
                    WHERE s.name = '${escapeSqlLiteral(schema)}'
                      AND t.name = '${escapeSqlLiteral(tableName)}'
                `
            );
            return rows[0]?.OWNER ?? null;
        },

        async generateTableDDL(
            connection: DatabaseConnection,
            database: string,
            schema: string,
            tableName: string
        ): Promise<string> {
            const columns = await this.getColumns(connection, database, schema, tableName);
            if (columns.length === 0) {
                throw new Error(
                    `Table [${schema}].[${tableName}] did not return any column metadata in database "${database}".`
                );
            }
            const keysInfo = await this.getKeysInfo(connection, database, schema, tableName);
            const comment = await this.getTableComment(connection, database, schema, tableName);
            return this.buildTableDDLFromCache(
                database,
                schema,
                tableName,
                columns,
                [],
                [],
                keysInfo,
                comment,
                null
            );
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
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            _owner?: string | null
        ): string {
            const columnClauses = columns.map((column) => {
                const parts = [`[${escapeBracketIdentifier(column.name)}]`, column.fullTypeName];
                if (column.notNull) {
                    parts.push('NOT NULL');
                }
                if (
                    column.defaultValue !== null &&
                    column.defaultValue !== undefined &&
                    column.defaultValue !== ''
                ) {
                    parts.push(`DEFAULT ${column.defaultValue}`);
                }
                return `    ${parts.join(' ')}`;
            });

            const constraintClauses = buildConstraintClauses(keysInfo).map(
                (clause) => `    ${clause}`
            );
            const definitionLines = [...columnClauses, ...constraintClauses];
            let ddl = `CREATE TABLE [${escapeBracketIdentifier(schema)}].[${escapeBracketIdentifier(tableName)}] (\n${definitionLines.join(',\n')}\n);`;

            if (tableComment) {
                ddl +=
                    `\n\nEXEC sys.sp_addextendedproperty` +
                    ` @name = N'MS_Description',` +
                    ` @value = N'${escapeSqlLiteral(tableComment)}',` +
                    ` @level0type = N'SCHEMA', @level0name = N'${escapeSqlLiteral(schema)}',` +
                    ` @level1type = N'TABLE', @level1name = N'${escapeSqlLiteral(tableName)}';`;
            }

            return ddl;
        },

        async generateViewDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            viewName: string
        ): Promise<string> {
            const rows = await executeDatabaseQuery<MsSqlObjectDefinitionRow>(
                connection,
                `
                    SELECT sm.definition AS DEFINITION
                    FROM sys.sql_modules sm
                    JOIN sys.objects o ON sm.object_id = o.object_id
                    JOIN sys.schemas s ON o.schema_id = s.schema_id
                    WHERE o.type = 'V'
                      AND s.name = '${escapeSqlLiteral(schema)}'
                      AND o.name = '${escapeSqlLiteral(viewName)}'
                `
            );

            const definition = rows[0]?.DEFINITION?.trim();
            if (!definition) {
                throw new Error(
                    `View [${schema}].[${viewName}] does not expose a definition in sys.sql_modules.`
                );
            }

            return definition.endsWith(';') ? definition : `${definition};`;
        },

        async generateProcedureDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            procSignature: string
        ): Promise<string> {
            const procName = procSignature.includes('(')
                ? procSignature.slice(0, procSignature.indexOf('('))
                : procSignature;

            const rows = await executeDatabaseQuery<MsSqlObjectDefinitionRow>(
                connection,
                `
                    SELECT sm.definition AS DEFINITION
                    FROM sys.sql_modules sm
                    JOIN sys.objects o ON sm.object_id = o.object_id
                    JOIN sys.schemas s ON o.schema_id = s.schema_id
                    WHERE o.type IN ('P', 'FN', 'TF', 'IF')
                      AND s.name = '${escapeSqlLiteral(schema)}'
                      AND o.name = '${escapeSqlLiteral(procName)}'
                `
            );

            const definition = rows[0]?.DEFINITION?.trim();
            if (!definition) {
                throw new Error(
                    `Procedure/Function [${schema}].[${procName}] does not expose a definition in sys.sql_modules.`
                );
            }

            return definition.endsWith(';') ? definition : `${definition};`;
        },

        async generateExternalTableDDL(): Promise<string> {
            throw new Error('Not supported.');
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('Not supported.');
        },

        async generateBatchDDL(
            options: DatabaseBatchDDLOptions
        ): Promise<DatabaseBatchDDLResult> {
            const connection = await createConnectionFromDetails(options.connectionDetails, options.database);
            try {
                const schema = options.schema;
                const requestedTypes = (options.objectTypes || []).map((type) =>
                    type.trim().toUpperCase()
                );
                const supportedTypes = ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION'];
                const effectiveTypes =
                    requestedTypes.length > 0
                        ? requestedTypes.filter((type) => supportedTypes.includes(type))
                        : supportedTypes;

                if (requestedTypes.length > 0 && effectiveTypes.length === 0) {
                    return {
                        success: false,
                        objectCount: 0,
                        errors: ['Selected object types are not supported by MSSQL DDL export.'],
                        skipped: 0
                    };
                }

                const ddlStatements: string[] = [];
                const errors: string[] = [];
                let skipped = 0;

                // Tables
                if (effectiveTypes.includes('TABLE')) {
                    const tableFilter = schema
                        ? `AND s.name = '${escapeSqlLiteral(schema)}'`
                        : '';
                    const tables = await executeDatabaseQuery<{ SCHEMA_NAME?: string; TABLE_NAME?: string }>(
                        connection,
                        `
                            SELECT s.name AS SCHEMA_NAME, t.name AS TABLE_NAME
                            FROM sys.tables t
                            JOIN sys.schemas s ON t.schema_id = s.schema_id
                            WHERE t.is_ms_shipped = 0 ${tableFilter}
                            ORDER BY s.name, t.name
                        `
                    );
                    for (const table of tables) {
                        try {
                            const ddl = await this.generateTableDDL(
                                connection,
                                options.database,
                                table.SCHEMA_NAME || 'dbo',
                                table.TABLE_NAME || ''
                            );
                            ddlStatements.push(ddl);
                        } catch {
                            skipped++;
                        }
                    }
                }

                // Views and procedures
                for (const objectType of effectiveTypes) {
                    if (objectType === 'TABLE') {
                        continue;
                    }
                    const typeFilter =
                        objectType === 'VIEW'
                            ? "o.type = 'V'"
                            : "o.type IN ('P', 'FN', 'TF', 'IF')";
                    const schemaFilter = schema
                        ? `AND s.name = '${escapeSqlLiteral(schema)}'`
                        : '';
                    const objects = await executeDatabaseQuery<{
                        SCHEMA_NAME?: string;
                        OBJECT_NAME?: string;
                        DEFINITION?: string | null;
                    }>(
                        connection,
                        `
                            SELECT
                                s.name AS SCHEMA_NAME,
                                o.name AS OBJECT_NAME,
                                sm.definition AS DEFINITION
                            FROM sys.sql_modules sm
                            JOIN sys.objects o ON sm.object_id = o.object_id
                            JOIN sys.schemas s ON o.schema_id = s.schema_id
                            WHERE ${typeFilter}
                              AND o.is_ms_shipped = 0
                              ${schemaFilter}
                            ORDER BY s.name, o.name
                        `
                    );

                    for (const obj of objects) {
                        const definition = obj.DEFINITION?.trim();
                        if (definition) {
                            ddlStatements.push(
                                definition.endsWith(';') ? definition : `${definition};`
                            );
                        } else {
                            skipped++;
                        }
                    }
                }

                return {
                    success: ddlStatements.length > 0,
                    ddlCode: ddlStatements.join('\n\nGO\n\n'),
                    objectCount: ddlStatements.length,
                    errors:
                        ddlStatements.length > 0
                            ? errors
                            : ['No MSSQL objects with stored DDL were found.'],
                    skipped
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
            const connection = await createConnectionFromDetails(connectionDetails, database);
            try {
                let ddlCode: string;
                const normalizedObjectType = objectType.trim().toUpperCase();

                if (normalizedObjectType === 'TABLE') {
                    ddlCode = await this.generateTableDDL(
                        connection,
                        database,
                        schema,
                        objectName
                    );
                } else if (normalizedObjectType === 'VIEW') {
                    ddlCode = await this.generateViewDDL(
                        connection,
                        database,
                        schema,
                        objectName
                    );
                } else if (
                    normalizedObjectType === 'PROCEDURE' ||
                    normalizedObjectType === 'FUNCTION'
                ) {
                    ddlCode = await this.generateProcedureDDL(
                        connection,
                        database,
                        schema,
                        objectName
                    );
                } else {
                    return {
                        success: false,
                        error: `MSSQL does not support DDL generation for object type "${objectType}".`
                    };
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
    }
};
