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
import { getErrorMessage } from '../../../src/core/connectionUtils';
import { executeDatabaseQuery } from '../../../src/core/connectionFactory';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import { VerticaConnection } from './verticaConnection';
import { verticaImportTypeMapper } from './verticaImportTypeMapper';
import { verticaMaintenanceProvider } from './verticaMaintenanceProvider';
import { verticaCopilotReferenceProvider } from './verticaReferenceProvider';
import { verticaSessionMonitorProvider } from './verticaSessionMonitorProvider';
import { verticaTuningAdvisor } from './verticaTuningAdvisor';
import {
    buildDdlColumnsQuery,
    buildFindTableSchemaQuery,
    buildKeysInfoQuery,
    buildListProceduresQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildObjectTypeQuery,
    buildTableCommentQuery,
    buildTableOwnerQuery,
} from './verticaSystemQueries';

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
    ENFORCED?: string | null;
}

interface TextRow {
    DESCRIPTION?: string | null;
    OWNER?: string | null;
    SCHEMA?: string | null;
    OBJNAME?: string | null;
    PROCEDURESIGNATURE?: string | null;
}

const SUPPORTED_BATCH_TYPES = new Set(['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'PROJECTION']);

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
    return formatQualifiedObjectName(undefined, schema, objectName, 'vertica');
}

function formatConstraintColumns(columns: readonly string[]): string {
    return columns.map((column) => formatIdentifierForSql(column, 'vertica')).join(', ');
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
            enforced: row.ENFORCED || undefined,
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

function buildConstraintClauses(keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const clauses: string[] = [];

    for (const [constraintName, keyInfo] of keysInfo) {
        const normalizedType = (keyInfo.type || '').trim().toUpperCase();
        const normalizedTypeChar = (keyInfo.typeChar || '').trim().toUpperCase();
        const columns = formatConstraintColumns(keyInfo.columns);
        const constraintPrefix = constraintName ? `CONSTRAINT ${formatIdentifierForSql(constraintName, 'vertica')} ` : '';

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
        if (normalizedTypeChar === 'F' || normalizedType.includes('FOREIGN')) {
            const referencedTable = keyInfo.pkRelation ? formatIdentifierForSql(keyInfo.pkRelation, 'vertica') : undefined;
            const referencedColumns = formatConstraintColumns(keyInfo.pkColumns);
            const referencedSchema = keyInfo.pkSchema ? `${formatIdentifierForSql(keyInfo.pkSchema, 'vertica')}.` : '';
            if (!referencedTable || !referencedColumns) {
                continue;
            }
            clauses.push(`${constraintPrefix}FOREIGN KEY (${columns}) REFERENCES ${referencedSchema}${referencedTable} (${referencedColumns})`);
        }
    }

    return clauses;
}

async function withConnection<T>(details: ConnectionDetails, task: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    const connection = new VerticaConnection({
        host: details.host,
        port: details.port,
        database: details.database,
        user: details.user,
        password: details.password,
        options: details.options,
    });

    await connection.connect();
    try {
        return await task(connection);
    } finally {
        await connection.close();
    }
}

async function exportObjectDdl(connection: DatabaseConnection, scope: string): Promise<string> {
    const rows = await executeDatabaseQuery<Record<string, unknown>>(
        connection,
        `SELECT EXPORT_OBJECTS('', ${quoteLiteral(scope)}, false) AS DDL`,
    );
    const ddl = rows[0]?.DDL;
    if (typeof ddl !== 'string' || ddl.trim().length === 0) {
        throw new Error(`Vertica did not return DDL for scope ${scope}.`);
    }
    return ensureStatementTerminated(ddl.replace(/\nSELECT\s+MARK_DESIGN_KSAFE\([^)]*\);?\s*$/i, '').trim());
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
    if (normalizedType === 'TABLE') {
        const rows = await executeDatabaseQuery<TextRow>(connection, buildFindTableSchemaQuery(objectName));
        const resolvedSchema = rows[0]?.SCHEMA?.trim();
        if (resolvedSchema) {
            return resolvedSchema;
        }
    }

    if (SUPPORTED_BATCH_TYPES.has(normalizedType)) {
        const rows = await executeDatabaseQuery<TextRow>(connection, buildObjectTypeQuery(normalizedType));
        const resolvedSchema = rows.find((row) => row.OBJNAME?.toUpperCase() === objectName.trim().toUpperCase())?.SCHEMA?.trim();
        if (resolvedSchema) {
            return resolvedSchema;
        }
    }

    throw new Error(`Schema is required to generate DDL for ${objectType} ${objectName}.`);
}

function buildExportScope(schema: string, objectName: string): string {
    return `${schema}.${objectName}`;
}

function buildTableDdlFromCacheInternal(
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
    tableComment?: string | null,
): string {
    const bodyLines = columns.map((column) => {
        const parts = [
            formatIdentifierForSql(column.name, 'vertica'),
            column.fullTypeName || 'VARCHAR',
        ];
        if (column.notNull) {
            parts.push('NOT NULL');
        }
        if (column.defaultValue != null && column.defaultValue !== '') {
            parts.push(`DEFAULT ${column.defaultValue}`);
        }
        return parts.join(' ');
    });

    bodyLines.push(...buildConstraintClauses(keysInfo));

    const ddl = `CREATE TABLE ${formatQualifiedName(schema, tableName)} (\n${bodyLines.map((line) => `    ${line}`).join(',\n')}\n);`;
    if (!tableComment || tableComment.trim().length === 0) {
        return ddl;
    }

    return `${ddl}\nCOMMENT ON TABLE ${formatQualifiedName(schema, tableName)} IS ${quoteLiteral(tableComment.trim())};`;
}

export const verticaAdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: verticaImportTypeMapper,
    tuningAdvisor: verticaTuningAdvisor,
    maintenance: verticaMaintenanceProvider,
    copilotReferenceProvider: verticaCopilotReferenceProvider,
    sessionMonitor: verticaSessionMonitorProvider,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifierForSql(name, 'vertica');
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
        async getColumns(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<DatabaseDdlColumnInfo[]> {
            const rows = await executeDatabaseQuery<ColumnRow>(connection, buildDdlColumnsQuery(schema, tableName));
            return rowsToDdlColumns(rows);
        },
        async getDistributionInfo(): Promise<string[]> {
            return [];
        },
        async getOrganizeInfo(): Promise<string[]> {
            return [];
        },
        async getKeysInfo(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<Map<string, DatabaseDdlKeyInfo>> {
            const rows = await executeDatabaseQuery<KeyRow>(connection, buildKeysInfoQuery(schema, tableName));
            return rowsToKeyInfoMap(rows);
        },
        async getTableComment(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<string | null> {
            const rows = await executeDatabaseQuery<TextRow>(connection, buildTableCommentQuery(schema, tableName));
            return rows[0]?.DESCRIPTION?.trim() || null;
        },
        async getTableOwner(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<string | null> {
            const rows = await executeDatabaseQuery<TextRow>(connection, buildTableOwnerQuery(schema, tableName));
            return rows[0]?.OWNER?.trim() || null;
        },
        async generateTableDDL(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<string> {
            return exportObjectDdl(connection, buildExportScope(schema, tableName));
        },
        buildTableDDLFromCache(_database: string, schema: string, tableName: string, columns: DatabaseDdlColumnInfo[], _distributionColumns: string[], _organizeColumns: string[], keysInfo: Map<string, DatabaseDdlKeyInfo>, tableComment?: string | null): string {
            return buildTableDdlFromCacheInternal(schema, tableName, columns, keysInfo, tableComment);
        },
        async generateViewDDL(connection: DatabaseConnection, _database: string, schema: string, viewName: string): Promise<string> {
            return exportObjectDdl(connection, buildExportScope(schema, viewName));
        },
        async generateProcedureDDL(connection: DatabaseConnection, _database: string, schema: string, procSignature: string): Promise<string> {
            return exportObjectDdl(connection, buildExportScope(schema, procSignature));
        },
        async generateExternalTableDDL(connection: DatabaseConnection, _database: string, schema: string, tableName: string): Promise<string> {
            return exportObjectDdl(connection, buildExportScope(schema, tableName));
        },
        async generateSynonymDDL(): Promise<string> {
            throw new Error('Vertica does not expose synonym DDL support through this provider.');
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            return withConnection(options.connectionDetails, async (connection) => {
                const objectTypes = options.objectTypes?.map((type) => type.trim().toUpperCase()) ?? ['TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE'];
                const ddlParts: string[] = [];
                const errors: string[] = [];
                let objectCount = 0;

                for (const objectType of objectTypes) {
                    let query = buildObjectTypeQuery(objectType);
                    if (objectType === 'TABLE') {
                        query = buildListTablesQuery(options.schema);
                    } else if (objectType === 'VIEW') {
                        query = buildListViewsQuery(options.schema);
                    } else if (objectType === 'PROCEDURE') {
                        query = buildListProceduresQuery(options.schema);
                    }

                    const rows = await executeDatabaseQuery<TextRow>(connection, query);
                    for (const row of rows) {
                        const schema = row.SCHEMA?.trim();
                        const objectName = row.PROCEDURESIGNATURE?.trim() || row.OBJNAME?.trim();
                        if (!schema || !objectName) {
                            continue;
                        }
                        if (options.schema && schema.toUpperCase() !== options.schema.toUpperCase()) {
                            continue;
                        }

                        try {
                            ddlParts.push(await exportObjectDdl(connection, buildExportScope(schema, objectName)));
                            objectCount += 1;
                        } catch (error) {
                            errors.push(getErrorMessage(error));
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
        },
        async generateDDL(connectionDetails: ConnectionDetails, _database: string, schema: string, objectName: string, objectType: string): Promise<DatabaseDdlResult> {
            try {
                const normalizedType = objectType.trim().toUpperCase();
                const ddlCode = await withConnection(connectionDetails, async (connection) => {
                    const resolvedSchema = await resolveSchemaIfMissing(connection, schema, objectName, normalizedType);
                    if (normalizedType === 'TABLE') {
                        return exportObjectDdl(connection, buildExportScope(resolvedSchema, objectName));
                    }
                    if (normalizedType === 'VIEW') {
                        return exportObjectDdl(connection, buildExportScope(resolvedSchema, objectName));
                    }
                    if (normalizedType === 'FUNCTION' || normalizedType === 'PROCEDURE' || normalizedType === 'PROJECTION') {
                        return exportObjectDdl(connection, buildExportScope(resolvedSchema, objectName));
                    }
                    return exportObjectDdl(connection, buildExportScope(resolvedSchema, objectName));
                });

                return {
                    success: true,
                    ddlCode,
                    objectInfo: {
                        database: connectionDetails.database,
                        schema,
                        objectName,
                        objectType: normalizedType,
                    },
                };
            } catch (error) {
                return {
                    success: false,
                    error: getErrorMessage(error),
                };
            }
        },
    },
};
