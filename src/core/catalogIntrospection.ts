import { ConnectionDetails } from '../types';
import {
    createConnectedNetezzaConnectionFromDetails,
    executeNetezzaDatabaseQuery
} from './mcpConnectionFactory';
import { generateDDL as generateNetezzaDDL } from '../dialects/netezza/ddl/ddlGenerator';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';

/**
 * Read-only Netezza catalog introspection core.
 *
 * This module is intentionally free of any `vscode` imports so it can be
 * shared between the VS Code extension host (Copilot language model tools)
 * and the standalone MCP server process (dist/mcp/mcpServer.js).
 *
 * All queries issued here are SELECT-only against the `_V_*` catalog views.
 * No user table data is ever read.
 */

export interface CatalogIntrospectionOptions {
    getConnectionDetails(): Promise<ConnectionDetails>;
}

export interface CatalogObjectType {
    objectName: string;
    objectType: string;
    database?: string;
    schema?: string;
}

const JSON_SAFE_REPLACER = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') {
        if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
            return Number(value);
        }
        return value.toString();
    }
    return value;
};

function normalizeBooleanFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        return ['1', 't', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    }
    return false;
}

export class CatalogIntrospection {
    constructor(private readonly options: CatalogIntrospectionOptions) { }

    private async getDetails(): Promise<ConnectionDetails> {
        return this.options.getConnectionDetails();
    }

    private async currentDatabase(): Promise<string | undefined> {
        const details = await this.getDetails();
        return details.database || undefined;
    }

    private async resolveDatabase(database?: string): Promise<string | undefined> {
        if (database && database.trim().length > 0) {
            return database.trim();
        }
        return this.currentDatabase();
    }

    private async openConnection(databaseOverride?: string) {
        const details = await this.getDetails();
        return createConnectedNetezzaConnectionFromDetails(details, databaseOverride);
    }

    private async queryRows(sql: string, databaseOverride?: string): Promise<Record<string, unknown>[]> {
        const connection = await this.openConnection(databaseOverride);
        try {
            return await executeNetezzaDatabaseQuery<Record<string, unknown>>(connection, sql);
        } finally {
            await connection.close();
        }
    }

    private formatJson(rows: Record<string, unknown>[], emptyMessage: string): string {
        if (rows.length === 0) {
            return emptyMessage;
        }
        return JSON.stringify(rows, JSON_SAFE_REPLACER, 2);
    }

    /**
     * Executes an already-gated EXPLAIN statement (see `mcpReadOnlyGate`) and
     * returns the plan text captured from the driver NOTICE events.
     */
    async explain(explainSql: string, database?: string): Promise<string> {
        const connection = await this.openConnection(database);
        const notices: string[] = [];

        const noticeHandler = (msg: unknown): void => {
            const notification = msg as { message?: unknown };
            if (typeof notification.message === 'string') {
                notices.push(notification.message);
            }
        };

        connection.on('notice', noticeHandler);
        try {
            const command = connection.createCommand(explainSql);
            const reader = await command.executeReader();
            try {
                while (await reader.read()) {
                    // Drain reader; EXPLAIN text is captured from NOTICE events.
                }
            } finally {
                await reader.close();
            }
        } finally {
            connection.removeListener('notice', noticeHandler);
            await connection.close();
        }

        return notices.length > 0 ? notices.join('\n') : 'EXPLAIN executed, but no plan notices were returned.';
    }

    async getDatabases(): Promise<string> {
        const sql = 'SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE';
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No databases found');
    }

    async getSchemas(database?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            const rows = await this.queryRows('SELECT USERNAME as SCHEMA_NAME FROM _V_USER ORDER BY USERNAME');
            return this.formatJson(rows, 'No schemas found');
        }
        const sql = `SELECT SCHEMA_NAME FROM ${escapeSqlIdentifier(db)}.._V_SCHEMA ORDER BY SCHEMA_NAME`;
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No schemas found');
    }

    async getTables(database?: string, schema?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            return 'No database specified and no active connection';
        }
        const dbUpper = db.toUpperCase();
        let sql = `SELECT OWNER, TABLENAME, 'TABLE' as TYPE FROM ${escapeSqlIdentifier(dbUpper)}.._V_TABLE WHERE DATABASE = ${escapeSqlLiteral(dbUpper)} AND TABLENAME NOT LIKE '_t_%'`;
        if (schema) {
            sql += ` AND OWNER = ${escapeSqlLiteral(schema.toUpperCase())}`;
        }
        sql += ' ORDER BY TABLENAME LIMIT 200';
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No tables found');
    }

    /**
     * Returns pipe-delimited table with header:
     * DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL
     * (same shape as the Copilot `netezza_get_columns` tool).
     */
    async getColumns(tables: string[], database?: string): Promise<string> {
        if (tables.length === 0) {
            return '[]';
        }

        const parsedTables = tables.map(t => {
            const parts = t.split('.');
            if (parts.length === 3) {
                return { database: parts[0].toUpperCase(), schema: parts[1].toUpperCase(), tableName: parts[2].toUpperCase() };
            } else if (parts.length === 2) {
                return { database: null, schema: parts[0].toUpperCase(), tableName: parts[1].toUpperCase() };
            }
            return { database: null, schema: null, tableName: parts[0].toUpperCase() };
        });

        let currentDatabase: string | undefined;
        if (parsedTables.some(t => !t.database)) {
            currentDatabase = (await this.resolveDatabase(database))?.toUpperCase();
        }
        if (parsedTables.some(table => !table.database) && !currentDatabase) {
            return '[]';
        }

        const lines: string[] = ['DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL'];
        const seen = new Set<string>();

        for (const table of parsedTables) {
            const db = table.database || currentDatabase;
            if (!db) {
                continue;
            }
            let sql = [
                `SELECT O.OBJNAME as TABLE_NAME, O.SCHEMA, O.DBNAME as DATABASE,`,
                `C.ATTNAME as COLUMN_NAME, C.FORMAT_TYPE as DATA_TYPE, C.ATTNOTNULL as NOT_NULL, C.ATTNUM`,
                `FROM ${escapeSqlIdentifier(db)}.._V_RELATION_COLUMN C`,
                `JOIN ${escapeSqlIdentifier(db)}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID`,
                `WHERE O.DBNAME = ${escapeSqlLiteral(db)}`,
                `  AND O.OBJTYPE IN ('TABLE','VIEW','EXTERNAL TABLE')`,
                `  AND O.OBJNAME = ${escapeSqlLiteral(table.tableName)}`
            ].join('\n');
            if (table.schema) {
                sql += ` AND O.SCHEMA = ${escapeSqlLiteral(table.schema)}`;
            }
            sql += ' ORDER BY C.ATTNUM';

            try {
                const rows = await this.queryRows(sql);
                for (const row of rows) {
                    const tableName = String(row.TABLE_NAME ?? '').toUpperCase();
                    const schemaName = String(row.SCHEMA ?? '').toUpperCase();
                    const columnName = String(row.COLUMN_NAME ?? '');
                    const key = `${db}.${schemaName}.${tableName}.${columnName}`;
                    if (seen.has(key) || tableName !== table.tableName) {
                        continue;
                    }
                    seen.add(key);
                    const dataType = String(row.DATA_TYPE ?? '');
                    const notNull = normalizeBooleanFlag(row.NOT_NULL) ? 't' : 'f';
                    lines.push(`${db}|${schemaName}|${tableName}|${columnName}|${dataType}|${notNull}`);
                }
            } catch {
                // Keep partial results when a single table lookup fails.
            }
        }

        return lines.length > 1 ? lines.join('\n') : '[]';
    }

    async getProcedures(database?: string, schema?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            return 'No database specified and no active connection';
        }
        const dbUpper = db.toUpperCase();
        let sql = `SELECT PROCEDURE, OWNER, RETURNS, BILTIN FROM ${escapeSqlIdentifier(dbUpper)}.._V_PROCEDURE WHERE DATABASE = ${escapeSqlLiteral(dbUpper)} AND BILTIN = 'f'`;
        if (schema) {
            sql += ` AND OWNER = ${escapeSqlLiteral(schema.toUpperCase())}`;
        }
        sql += ' ORDER BY PROCEDURE LIMIT 200';
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No procedures found');
    }

    async getViews(database?: string, schema?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            return 'No database specified and no active connection';
        }
        const dbUpper = db.toUpperCase();
        let sql = `SELECT VIEWNAME, OWNER FROM ${escapeSqlIdentifier(dbUpper)}.._V_VIEW WHERE DATABASE = ${escapeSqlLiteral(dbUpper)} AND VIEWNAME NOT LIKE '_v_%'`;
        if (schema) {
            sql += ` AND OWNER = ${escapeSqlLiteral(schema.toUpperCase())}`;
        }
        sql += ' ORDER BY VIEWNAME LIMIT 200';
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No views found');
    }

    async searchSchema(pattern: string, objectType: string, database?: string): Promise<string> {
        const like = escapeSqlLiteral(`%${pattern.toUpperCase()}%`);
        const normalizedType = (objectType || 'ALL').toUpperCase();
        const db = await this.resolveDatabase(database);
        const dbPrefix = db ? `${escapeSqlIdentifier(db)}..` : '';

        let sql: string;
        if (normalizedType === 'COLUMNS') {
            sql = `
                SELECT D.OBJNAME as TABLE_NAME, X.ATTNAME as COLUMN_NAME
                FROM ${dbPrefix}_V_RELATION_COLUMN X
                INNER JOIN ${dbPrefix}_V_OBJECT_DATA D ON X.OBJID = D.OBJID
                WHERE X.ATTNAME LIKE ${like}
                LIMIT 100
            `;
        } else if (normalizedType === 'TABLES' || normalizedType === 'TABLE') {
            sql = `SELECT TABLENAME, OWNER FROM ${dbPrefix}_V_TABLE WHERE TABLENAME LIKE ${like} LIMIT 100`;
        } else if (['VIEW', 'PROCEDURE', 'FUNCTION', 'AGGREGATE', 'SYNONYM', 'EXTERNAL TABLE'].includes(normalizedType)) {
            sql = `
                SELECT OBJNAME AS OBJECT_NAME, OBJTYPE AS TYPE, SCHEMA AS OWNER
                FROM ${dbPrefix}_V_OBJECT_DATA
                WHERE OBJTYPE = ${escapeSqlLiteral(normalizedType)} AND OBJNAME LIKE ${like}
                LIMIT 100
            `;
        } else {
            sql = `
                SELECT TABLENAME AS OBJECT_NAME, 'TABLE' AS TYPE FROM ${dbPrefix}_V_TABLE WHERE TABLENAME LIKE ${like}
                UNION ALL
                SELECT VIEWNAME AS OBJECT_NAME, 'VIEW' AS TYPE FROM ${dbPrefix}_V_VIEW WHERE VIEWNAME LIKE ${like}
                UNION ALL
                SELECT PROCEDURE AS OBJECT_NAME, 'PROCEDURE' AS TYPE FROM ${dbPrefix}_V_PROCEDURE WHERE PROCEDURE LIKE ${like}
                LIMIT 100
             `;
        }
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, 'No objects found');
    }

    async getObjectDefinition(objectName: string, objectType: 'view' | 'procedure', database?: string): Promise<string> {
        const parts = objectName.split('.');
        let db: string | undefined;
        let objName: string;

        if (parts.length === 3) {
            db = parts[0].toUpperCase();
            objName = parts[2].toUpperCase();
        } else if (parts.length === 2) {
            objName = parts[1].toUpperCase();
        } else {
            objName = objectName.toUpperCase();
        }

        if (!db) {
            db = database?.toUpperCase();
        }
        if (!db) {
            db = (await this.currentDatabase())?.toUpperCase();
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        if (objectType === 'view') {
            return this.getViewDefinitionWithDedicatedConnection(db, objName);
        }

        const sql = `SELECT PROCEDURESIGNATURE, RETURNS, PROCEDURESOURCE FROM ${escapeSqlIdentifier(db)}.._V_PROCEDURE WHERE DATABASE = ${escapeSqlLiteral(db)} AND PROCEDURE = ${escapeSqlLiteral(objName)}`;
        const rows = await this.queryRows(sql);
        return this.formatJson(rows, `Procedure "${objName}" not found`);
    }

    private async getViewDefinitionWithDedicatedConnection(database: string, viewName: string): Promise<string> {
        const sql = `SELECT DEFINITION FROM _V_VIEW WHERE DATABASE = ${escapeSqlLiteral(database)} AND VIEWNAME = ${escapeSqlLiteral(viewName)}`;
        const rows = await this.queryRows(sql, database);
        if (rows.length > 0 && rows[0].DEFINITION) {
            return JSON.stringify({ DEFINITION: rows[0].DEFINITION }, JSON_SAFE_REPLACER, 2);
        }
        return `View "${viewName}" not found in database "${database}" or has no definition.`;
    }

    async getDDL(params: CatalogObjectType): Promise<string> {
        const connectionDetails = await this.getDetails();
        const normalizedObjectType = (params.objectType || 'table').toLowerCase();

        const parts = params.objectName.toUpperCase().split('.');
        let db: string | undefined = params.database;
        let schemaName: string | undefined = params.schema;
        let objectName: string;
        let searchAllSchemas = false;

        if (parts.length === 1) {
            objectName = parts[0];
        } else if (parts.length === 2) {
            schemaName = parts[0];
            objectName = parts[1];
        } else if (parts.length === 3) {
            if (parts[1] === '') {
                db = parts[0];
                objectName = parts[2];
                searchAllSchemas = true;
            } else {
                db = parts[0];
                schemaName = parts[1];
                objectName = parts[2];
            }
        } else {
            throw new Error('Invalid object name format. Use: TABLENAME, SCHEMA.TABLENAME, DATABASE..TABLENAME, or DATABASE.SCHEMA.TABLENAME');
        }

        if (!db) {
            db = await this.currentDatabase();
        }
        if (!db) {
            throw new Error('Could not determine database. Please specify database or connect to one.');
        }

        if (searchAllSchemas) {
            const safeDb = escapeSqlIdentifier(db);
            const safeObjectName = escapeSqlLiteral(objectName);
            const schemaSearchQueries: string[] = [];
            if (normalizedObjectType === 'view') {
                schemaSearchQueries.push(`SELECT OWNER FROM ${safeDb}.._V_VIEW WHERE VIEWNAME = ${safeObjectName} LIMIT 1`);
            } else if (normalizedObjectType === 'procedure') {
                schemaSearchQueries.push(`SELECT SCHEMA FROM ${safeDb}.._V_PROCEDURE WHERE PROCEDURE = ${safeObjectName} LIMIT 1`);
            } else {
                schemaSearchQueries.push(
                    `SELECT OWNER FROM ${safeDb}.._V_TABLE WHERE TABLENAME = ${safeObjectName} LIMIT 1`,
                    `SELECT OWNER FROM ${safeDb}.._V_VIEW WHERE VIEWNAME = ${safeObjectName} LIMIT 1`,
                    `SELECT SCHEMA FROM ${safeDb}.._V_PROCEDURE WHERE PROCEDURE = ${safeObjectName} LIMIT 1`
                );
            }
            for (const schemaQuery of schemaSearchQueries) {
                try {
                    const rows = await this.queryRows(schemaQuery);
                    const firstValue = rows.length > 0 ? Object.values(rows[0])[0] : undefined;
                    if (firstValue !== undefined && firstValue !== null) {
                        schemaName = String(firstValue);
                        break;
                    }
                } catch {
                    // Try next metadata source and fall back to ADMIN when none resolve.
                }
            }
            if (!schemaName) {
                schemaName = 'ADMIN';
            }
        }

        if (!schemaName) {
            schemaName = 'ADMIN';
        }

        const result = await generateNetezzaDDL(
            connectionDetails,
            db,
            schemaName,
            objectName,
            normalizedObjectType
        );

        if (result.success) {
            return `## DDL for ${normalizedObjectType.toUpperCase()}: ${db}.${schemaName}.${objectName}\n\n` +
                '```sql\n' + result.ddlCode + '\n```';
        }
        return `Failed to generate DDL: ${result.error}`;
    }
}
