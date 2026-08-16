/**
 * DDL provider for Microsoft Access (.mdb/.accdb).
 *
 * Reads table and saved-query metadata through the Access connection's
 * `_access_metadata.*` markers and emits Access SQL DDL (bracket identifiers,
 * UCanAccess/HSQLDB-compatible type names) that can be replayed against the
 * file through Access, UCanAccess, or the JustyBase.UCanAccessCs port.
 */

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
import { AccessConnection } from './accessConnection';

interface TableColumnRow {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number | string;
    IS_PK?: number | string;
    IS_AUTO?: number | string;
    IS_CALC?: number | string;
    ATTNUM?: number | string;
    DESCRIPTION?: string | null;
}

interface ObjectNameRow {
    OBJNAME?: string;
}

interface ViewSourceRow {
    NAME?: string;
    SOURCE?: string | null;
}

interface RelationshipRow {
    RELATIONSHIP?: string;
    TABLE?: string;
    COLUMN?: string;
    FOREIGN_TABLE?: string;
    FOREIGN_COLUMN?: string;
    ENFORCED?: number | string;
}

type AccessDdlProvider = NonNullable<DatabaseAdvancedFeatures['ddl']>;

function quoteAccessIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
}

function quoteAccessLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function isFlagSet(value: number | string | undefined): boolean {
    return Number(value) === 1;
}

/**
 * Maps the FORMAT_TYPE value produced by the Access connection to the Access
 * DDL type name accepted by the UCanAccess 5.1.6 grammar (see the
 * JustyBase.UCanAccessCs AccessDdl column-type table). AutoNumber columns are
 * expressed as COUNTER (LONG) or keep GUID for ReplicationID columns.
 */
function toAccessDdlType(formatType: string, isAuto: boolean): string {
    const trimmed = formatType.trim();
    const upper = trimmed.toUpperCase();
    if (isAuto) {
        return upper === 'GUID' ? 'GUID' : 'COUNTER';
    }
    switch (upper) {
        case 'BOOLEAN':
        case 'BYTE':
        case 'SHORT':
        case 'LONG':
        case 'BIGINT':
        case 'CURRENCY':
        case 'SINGLE':
        case 'DOUBLE':
        case 'DATETIME':
        case 'BINARY':
        case 'OLE':
        case 'MEMO':
        case 'GUID':
        case 'COMPLEX':
            return upper;
        default: {
            const textLength = upper.match(/^VARCHAR\((\d+)\)$/);
            if (textLength) {
                return `TEXT(${textLength[1]})`;
            }
            const numeric = upper.match(/^DECIMAL\(\d+(,\d+)?\)$/);
            if (numeric) {
                return upper;
            }
            return upper || 'UNKNOWN';
        }
    }
}

/**
 * Drops a leading `PARAMETERS ...;` clause from a saved-query source so the
 * remaining SELECT can be embedded in CREATE VIEW.
 */
function stripParametersClause(sql: string): string {
    if (!/^\s*PARAMETERS\b/i.test(sql)) {
        return sql;
    }
    const semicolon = sql.indexOf(';');
    return semicolon < 0 ? sql : sql.slice(semicolon + 1).trim();
}

async function createConnectionFromDetails(connectionDetails: ConnectionDetails): Promise<DatabaseConnection> {
    const connection = new AccessConnection({
        host: connectionDetails.host || '',
        database: connectionDetails.database,
        user: connectionDetails.user || '',
        password: connectionDetails.password,
        options: { ...connectionDetails.options, readOnly: true },
    });
    await connection.connect();
    return connection;
}

async function getTableColumnRows(
    connection: DatabaseConnection,
    tableName: string,
): Promise<TableColumnRow[]> {
    return executeDatabaseQuery<TableColumnRow>(
        connection,
        `SELECT * FROM _access_metadata.table_columns WHERE TABLE = ${quoteAccessLiteral(tableName)}`,
    );
}

export const accessDdlProvider: AccessDdlProvider = {
    quoteNameIfNeeded(name: string): string {
        return quoteAccessIdentifier(name);
    },
    buildFindTableSchemaQuery(_database: string, _tableName: string): string {
        return `SELECT 'default' AS SCHEMA`;
    },
    buildTableStatsQuery(_database: string, _schema: string, tableName: string): string {
        return `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteAccessIdentifier(tableName)}`;
    },
    buildSkewCheckQuery(qualifiedTableName: string): string {
        return `SELECT 1 AS DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName}`;
    },
    async getColumns(
        connection: DatabaseConnection,
        _database: string,
        _schema: string,
        tableName: string,
    ): Promise<DatabaseDdlColumnInfo[]> {
        const rows = await getTableColumnRows(connection, tableName);
        return rows.map(row => ({
            name: row.ATTNAME || '',
            description: row.DESCRIPTION ? String(row.DESCRIPTION) : null,
            // Calculated fields cannot be recreated through Access DDL; the
            // dedicated type name lets buildTableDDLFromCache skip them.
            fullTypeName: isFlagSet(row.IS_CALC)
                ? 'CALCULATED'
                : toAccessDdlType(row.FORMAT_TYPE ?? 'UNKNOWN', isFlagSet(row.IS_AUTO)),
            notNull: isFlagSet(row.IS_NOT_NULL),
            defaultValue: null,
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
        _schema: string,
        tableName: string,
    ): Promise<Map<string, DatabaseDdlKeyInfo>> {
        const rows = await getTableColumnRows(connection, tableName);
        const primaryKeyColumns = rows
            .filter(row => isFlagSet(row.IS_PK))
            .sort((left, right) => Number(left.ATTNUM ?? 0) - Number(right.ATTNUM ?? 0))
            .map(row => row.ATTNAME || '')
            .filter(column => column.length > 0);
        const keysInfo = new Map<string, DatabaseDdlKeyInfo>();
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
                deleteType: '',
            });
        }
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
        tableName: string,
    ): Promise<string> {
        const columns = await this.getColumns(connection, database, schema, tableName);
        if (columns.length === 0) {
            throw new Error(`Access table "${tableName}" exposes no readable columns.`);
        }
        const keysInfo = await this.getKeysInfo(connection, database, schema, tableName);
        const createStatement = this.buildTableDDLFromCache(database, schema, tableName, columns, [], [], keysInfo);

        const relationshipRows = await executeDatabaseQuery<RelationshipRow>(
            connection,
            `SELECT * FROM _access_metadata.relationships WHERE TABLE = ${quoteAccessLiteral(tableName)}`,
        );
        const foreignKeyStatements = relationshipRows
            .map(row => {
                const name = row.RELATIONSHIP?.trim();
                const columnsList = (row.COLUMN || '').split(',').filter(Boolean).map(quoteAccessIdentifier);
                const foreignTable = row.FOREIGN_TABLE?.trim();
                const foreignColumns = (row.FOREIGN_COLUMN || '').split(',').filter(Boolean).map(quoteAccessIdentifier);
                if (!name || columnsList.length === 0 || !foreignTable || foreignColumns.length !== columnsList.length) {
                    return null;
                }
                return `ALTER TABLE ${quoteAccessIdentifier(tableName)} ADD CONSTRAINT ${quoteAccessIdentifier(name)}`
                    + ` FOREIGN KEY (${columnsList.join(', ')}) REFERENCES ${quoteAccessIdentifier(foreignTable)} (${foreignColumns.join(', ')});`;
            })
            .filter((statement): statement is string => statement !== null);

        return foreignKeyStatements.length > 0
            ? `${createStatement}\n\n${foreignKeyStatements.join('\n')}`
            : createStatement;
    },
    buildTableDDLFromCache(
        _database: string,
        _schema: string,
        tableName: string,
        columns: DatabaseDdlColumnInfo[],
        _distributionColumns: string[],
        _organizeColumns: string[],
        keysInfo: Map<string, DatabaseDdlKeyInfo>,
        _tableComment?: string | null,
    ): string {
        const primaryKey = Array.from(keysInfo.values()).find(key => (key.typeChar || '').toUpperCase() === 'P');
        const primaryKeyColumns = primaryKey?.columns ?? [];
        const singlePrimaryKeyColumn = primaryKeyColumns.length === 1
            ? primaryKeyColumns[0].toLowerCase()
            : undefined;
        const compositePrimaryKeyColumns = new Set(
            primaryKeyColumns.length > 1 ? primaryKeyColumns.map(column => column.toLowerCase()) : [],
        );

        const columnLines: string[] = [];
        const calculatedLines: string[] = [];
        for (const column of columns) {
            if (column.fullTypeName.toUpperCase() === 'CALCULATED') {
                calculatedLines.push(
                    `-- [${column.name.replace(/]/g, ']]')}] — calculated field; cannot be recreated through Access DDL`,
                );
                continue;
            }
            const parts = [quoteAccessIdentifier(column.name), column.fullTypeName];
            // AutoNumber (COUNTER) and ReplicationID (GUID) columns are stored
            // without the Required flag in Jet files even when they form the
            // primary key, so NOT NULL must not be emitted for them or the
            // replayed schema would differ from the source.
            const isAutoLike = /^(COUNTER|GUID)$/i.test(column.fullTypeName);
            const columnKey = column.name.toLowerCase();
            const isSinglePrimaryKey = singlePrimaryKeyColumn !== undefined
                && columnKey === singlePrimaryKeyColumn;
            const isCompositePrimaryKey = compositePrimaryKeyColumns.has(columnKey);
            if (isSinglePrimaryKey) {
                if (!isAutoLike) {
                    parts.push('NOT NULL');
                }
                parts.push('PRIMARY KEY');
            } else if (isCompositePrimaryKey) {
                if (!isAutoLike) {
                    parts.push('NOT NULL');
                }
            } else if (column.notNull && !isAutoLike) {
                parts.push('NOT NULL');
            }
            columnLines.push(`    ${parts.join(' ')}`);
        }

        if (primaryKeyColumns.length > 1) {
            columnLines.push(`    PRIMARY KEY (${primaryKeyColumns.map(quoteAccessIdentifier).join(', ')})`);
        }

        const createStatement = `CREATE TABLE ${quoteAccessIdentifier(tableName)} (\n${columnLines.join(',\n')}\n);`;
        return calculatedLines.length > 0
            ? `${calculatedLines.join('\n')}\n${createStatement}`
            : createStatement;
    },
    async generateViewDDL(
        connection: DatabaseConnection,
        _database: string,
        _schema: string,
        viewName: string,
    ): Promise<string> {
        const rows = await executeDatabaseQuery<ViewSourceRow>(
            connection,
            `SELECT * FROM _access_metadata.view_source_search WHERE PATTERN = '%' AND SERVER_SIDE = 0`,
        );
        const view = rows.find(row => (row.NAME || '').toLowerCase() === viewName.toLowerCase());
        const source = view?.SOURCE?.trim();
        if (!source) {
            throw new Error(`Access view text is unavailable for ${viewName}.`);
        }
        return `CREATE VIEW ${quoteAccessIdentifier(viewName)} AS\n${stripParametersClause(source)};`;
    },
    async generateProcedureDDL(): Promise<string> {
        throw new Error('Microsoft Access does not support stored procedures.');
    },
    async generateExternalTableDDL(): Promise<string> {
        throw new Error('Access external table DDL export is not implemented.');
    },
    async generateSynonymDDL(): Promise<string> {
        throw new Error('Microsoft Access does not support synonyms.');
    },
    async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
        const connection = await createConnectionFromDetails(options.connectionDetails);
        try {
            const requestedTypes = (options.objectTypes || [])
                .map(type => type.trim().toUpperCase());
            const includeTables = requestedTypes.length === 0 || requestedTypes.includes('TABLE');
            const includeViews = requestedTypes.length === 0 || requestedTypes.includes('VIEW');
            if (!includeTables && !includeViews) {
                return {
                    success: false,
                    objectCount: 0,
                    errors: ['Selected object types are not supported by Access DDL export.'],
                    skipped: 0,
                };
            }

            const errors: string[] = [];
            const statements: string[] = [];
            const schema = options.schema ?? '';

            if (includeTables) {
                const tables = await executeDatabaseQuery<ObjectNameRow>(
                    connection,
                    'SELECT * FROM _access_metadata.tables',
                );
                for (const table of tables) {
                    const tableName = table.OBJNAME?.trim();
                    if (!tableName) continue;
                    try {
                        statements.push(await this.generateTableDDL(connection, options.database, schema, tableName));
                    } catch (error) {
                        errors.push(`Error generating DDL for TABLE ${tableName}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }

            if (includeViews) {
                const views = await executeDatabaseQuery<ObjectNameRow>(
                    connection,
                    'SELECT * FROM _access_metadata.views',
                );
                for (const view of views) {
                    const viewName = view.OBJNAME?.trim();
                    if (!viewName) continue;
                    try {
                        statements.push(await this.generateViewDDL(connection, options.database, schema, viewName));
                    } catch (error) {
                        errors.push(`Error generating DDL for VIEW ${viewName}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }

            return {
                success: statements.length > 0,
                ddlCode: statements.join('\n\n'),
                objectCount: statements.length,
                errors,
                skipped: 0,
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
        const connection = await createConnectionFromDetails(connectionDetails);
        try {
            const normalizedType = objectType.trim().toUpperCase();
            let ddlCode: string;
            if (normalizedType === 'TABLE') {
                ddlCode = await this.generateTableDDL(connection, database, schema, objectName);
            } else if (normalizedType === 'VIEW') {
                ddlCode = await this.generateViewDDL(connection, database, schema, objectName);
            } else {
                return {
                    success: false,
                    error: `Access DDL generation is not implemented for object type "${objectType}".`,
                };
            }

            return {
                success: true,
                ddlCode,
                objectInfo: {
                    database,
                    schema,
                    objectName,
                    objectType,
                },
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
};
