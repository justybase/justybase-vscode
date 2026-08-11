import { ConnectionDetails } from '../types';
import {
    createConnectedNetezzaConnectionFromDetails,
    executeNetezzaDatabaseQuery
} from './mcpConnectionFactory';
import { generateDDL as generateNetezzaDDL } from '../dialects/netezza/ddl/ddlGenerator';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';
import { analyzeExplainPlanSemantic } from '../services/tuning/explainPlanSemanticAnalyzer';

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

interface ParsedCatalogReference {
    database?: string;
    schema?: string;
    objectName: string;
}

interface ResolvedCatalogReference extends ParsedCatalogReference {
    database: string;
    schema: string;
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

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSqlNoise(source: string): string {
    return source
        .replace(/--[^\r\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/'(?:''|[^'])*'/g, ' ')
        .replace(/"/g, '')
        .toUpperCase();
}

/**
 * Matches an object token in a relation/reference position. This intentionally
 * does not use a substring LIKE predicate: ORDERS must not match
 * ORDERS_ARCHIVE, a column named ORDERS, a literal, or a comment.
 */
function sourceReferencesCatalogObject(
    source: string,
    target: { database: string; schema: string; objectName: string }
): boolean {
    const normalizedSource = stripSqlNoise(source);
    const relationKeyword = '(?:FROM|JOIN|UPDATE|INTO|USING|CALL|REFERENCES)';
    const name = escapeRegexLiteral(target.objectName);
    const prefixes: string[] = [];

    prefixes.push(`${escapeRegexLiteral(target.schema)}\\s*\\.\\s*`);
    prefixes.push(`${escapeRegexLiteral(target.database)}\\s*\\.\\s*${escapeRegexLiteral(target.schema)}\\s*\\.\\s*`);
    prefixes.push(`${escapeRegexLiteral(target.database)}\\s*\\.\\.\\s*`);

    for (const prefix of prefixes) {
        const qualifiedPattern = new RegExp(
            `\\b${relationKeyword}\\s+${prefix}${name}(?![A-Z0-9_$\\.])`,
            'i'
        );
        if (qualifiedPattern.test(normalizedSource)) {
            return true;
        }
    }

    const unqualifiedPattern = new RegExp(
        `\\b${relationKeyword}\\s+${name}(?![A-Z0-9_$\\.])`,
        'i'
    );
    return unqualifiedPattern.test(normalizedSource);
}

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

    private catalogPrefix(database: string): string {
        return `${escapeSqlIdentifier(database)}..`;
    }

    private normalizeCatalogIdentifier(value: string, label: string): string {
        const normalized = value.trim().toUpperCase();
        if (!/^[A-Z_][A-Z0-9_$]*$/.test(normalized)) {
            throw new Error(`${label} must be a simple Netezza identifier.`);
        }
        return normalized;
    }

    private parseCatalogReference(input: string): ParsedCatalogReference {
        const value = input.trim();
        if (!value) {
            throw new Error('Object name is required.');
        }

        if (value.includes('..')) {
            const parts = value.split('..');
            if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
                throw new Error('Invalid object format. Use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
            }
            const right = parts[1].trim().split('.');
            if (right.length === 1) {
                return { database: parts[0].trim(), objectName: right[0].trim() };
            }
            if (right.length === 2 && right[0].trim() && right[1].trim()) {
                return { database: parts[0].trim(), schema: right[0].trim(), objectName: right[1].trim() };
            }
            throw new Error('Invalid DATABASE..OBJECT format. Expected DATABASE..TABLE or DATABASE..SCHEMA.TABLE.');
        }

        const parts = value.split('.');
        if (parts.length === 1 && parts[0].trim()) {
            return { objectName: parts[0].trim() };
        }
        if (parts.length === 2 && parts.every(part => part.trim())) {
            return { schema: parts[0].trim(), objectName: parts[1].trim() };
        }
        if (parts.length === 3 && parts.every(part => part.trim())) {
            return { database: parts[0].trim(), schema: parts[1].trim(), objectName: parts[2].trim() };
        }
        throw new Error('Invalid object format. Use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
    }

    private async resolveCatalogReference(
        input: string,
        database?: string,
        objectTypes: string[] = ['TABLE', 'VIEW', 'EXTERNAL TABLE']
    ): Promise<ResolvedCatalogReference> {
        const parsed = this.parseCatalogReference(input);
        const resolvedDatabase = (parsed.database || database || await this.currentDatabase())?.trim();
        if (!resolvedDatabase) {
            throw new Error('Could not determine database. Please specify database or connect to one.');
        }

        const db = resolvedDatabase.toUpperCase();
        const objectName = parsed.objectName.toUpperCase();
        const typeList = objectTypes.map(type => escapeSqlLiteral(type)).join(', ');
        const schemaClause = parsed.schema
            ? `AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(parsed.schema.toUpperCase())})`
            : '';
        const rows = await this.queryRows(`
            SELECT SCHEMA, OBJNAME, OBJTYPE
            FROM ${this.catalogPrefix(db)}_V_OBJECT_DATA
            WHERE DBNAME = ${escapeSqlLiteral(db)}
              AND UPPER(OBJNAME) = UPPER(${escapeSqlLiteral(objectName)})
              ${schemaClause}
              AND OBJTYPE IN (${typeList})
            ORDER BY SCHEMA, OBJTYPE
            LIMIT 2
        `, db);
        if (rows.length === 0) {
            throw new Error(`Object "${input}" not found in database "${db}".`);
        }
        if (rows.length > 1) {
            throw new Error(
                `Object "${input}" is ambiguous in database "${db}". Specify schema and an unambiguous object name.`
            );
        }
        const row = rows[0];
        const schema = String(row.SCHEMA ?? parsed.schema ?? '').toUpperCase();
        if (!schema) {
            throw new Error(`Object "${input}" has no resolvable schema in database "${db}".`);
        }
        return {
            database: db,
            schema,
            objectName: String(row.OBJNAME ?? objectName).toUpperCase()
        };
    }

    private async resolveAnyCatalogReference(
        input: string,
        database?: string,
        objectTypes: string[] = ['TABLE', 'VIEW', 'PROCEDURE']
    ): Promise<ResolvedCatalogReference & { objectType: string }> {
        const parsed = this.parseCatalogReference(input);
        const resolvedDatabase = (parsed.database || database || await this.currentDatabase())?.trim();
        if (!resolvedDatabase) {
            throw new Error('Could not determine database. Please specify database or connect to one.');
        }
        const db = resolvedDatabase.toUpperCase();
        const objectName = parsed.objectName.toUpperCase();
        const typeList = objectTypes.map(type => escapeSqlLiteral(type)).join(', ');
        const schemaClause = parsed.schema
            ? `AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(parsed.schema.toUpperCase())})`
            : '';
        const rows = await this.queryRows(`
            SELECT SCHEMA, OBJNAME, OBJTYPE
            FROM ${this.catalogPrefix(db)}_V_OBJECT_DATA
            WHERE DBNAME = ${escapeSqlLiteral(db)}
              AND UPPER(OBJNAME) = UPPER(${escapeSqlLiteral(objectName)})
              ${schemaClause}
              AND OBJTYPE IN (${typeList})
            ORDER BY SCHEMA, OBJTYPE
            LIMIT 2
        `, db);
        if (rows.length === 0) {
            throw new Error(`Object "${input}" not found in database "${db}".`);
        }
        if (rows.length > 1) {
            throw new Error(
                `Object "${input}" is ambiguous in database "${db}". Specify schema and objectType.`
            );
        }
        const row = rows[0];
        return {
            database: db,
            schema: String(row.SCHEMA ?? parsed.schema ?? 'ADMIN').toUpperCase(),
            objectName: String(row.OBJNAME ?? objectName).toUpperCase(),
            objectType: String(row.OBJTYPE ?? '').toUpperCase()
        };
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
        const sql = `SELECT SCHEMA AS SCHEMA_NAME FROM ${escapeSqlIdentifier(db)}.._V_SCHEMA ORDER BY SCHEMA`;
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

        const parsedTables = tables.map(table => {
            const parsed = this.parseCatalogReference(table);
            return {
                database: parsed.database?.toUpperCase() ?? null,
                schema: parsed.schema?.toUpperCase() ?? null,
                tableName: parsed.objectName.toUpperCase()
            };
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

    /**
     * Returns catalog-only statistics. This never reads rows from the user
     * table; row counts, skew and storage values come from Netezza catalog
     * views and distribution/organization maps.
     */
    async getTableStats(tableName: string, database?: string): Promise<string> {
        const target = await this.resolveCatalogReference(tableName, database, ['TABLE']);
        const prefix = this.catalogPrefix(target.database);
        const errors: string[] = [];
        const result: Record<string, unknown> = {
            database: target.database,
            schema: target.schema,
            tableName: target.objectName,
            source: 'Netezza catalog views',
            distributionKeys: [],
            organizeColumns: [],
            storage: null
        };

        try {
            const rows = await this.queryRows(`
                SELECT ATTNAME
                FROM ${prefix}_V_TABLE_DIST_MAP
                WHERE UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
                  AND UPPER(TABLENAME) = UPPER(${escapeSqlLiteral(target.objectName)})
                ORDER BY DISTSEQNO
            `, target.database);
            result.distributionKeys = rows.map(row => String(row.ATTNAME ?? '')).filter(Boolean);
        } catch (error: unknown) {
            errors.push(`distribution map: ${errorText(error)}`);
        }

        try {
            const rows = await this.queryRows(`
                SELECT ATTNAME
                FROM ${prefix}_V_TABLE_ORGANIZE_COLUMN
                WHERE UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
                  AND UPPER(TABLENAME) = UPPER(${escapeSqlLiteral(target.objectName)})
                ORDER BY ORGSEQNO
            `, target.database);
            result.organizeColumns = rows.map(row => String(row.ATTNAME ?? '')).filter(Boolean);
        } catch (error: unknown) {
            errors.push(`organize map: ${errorText(error)}`);
        }

        try {
            const rows = await this.queryRows(`
                SELECT TBL_ROWS, SKEW, USED_BYTES
                FROM ${prefix}_V_TABLE_STORAGE_STAT S
                JOIN ${prefix}_V_TABLE T ON S.OBJID = T.OBJID
                WHERE UPPER(T.SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
                  AND UPPER(T.TABLENAME) = UPPER(${escapeSqlLiteral(target.objectName)})
                LIMIT 1
            `, target.database);
            result.storage = rows[0] ?? null;
        } catch (error: unknown) {
            errors.push(`storage statistics: ${errorText(error)}`);
        }

        if (errors.length > 0) {
            result.partial = true;
            result.errors = errors;
        }
        return JSON.stringify(result, JSON_SAFE_REPLACER, 2);
    }

    /** Returns table and column DESCRIPTION values without reading table data. */
    async getComments(
        tableName: string,
        database?: string,
        schema?: string,
        includeColumns = true
    ): Promise<string> {
        const referenceInput = schema && !tableName.includes('.')
            ? `${schema}.${tableName}`
            : tableName;
        const target = await this.resolveCatalogReference(
            referenceInput,
            database,
            ['TABLE', 'VIEW', 'EXTERNAL TABLE']
        );
        const prefix = this.catalogPrefix(target.database);
        const tableRows = await this.queryRows(`
            SELECT DESCRIPTION, OWNER, OBJTYPE
            FROM ${prefix}_V_OBJECT_DATA
            WHERE DBNAME = ${escapeSqlLiteral(target.database)}
              AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
              AND UPPER(OBJNAME) = UPPER(${escapeSqlLiteral(target.objectName)})
        `, target.database);

        const result: Record<string, unknown> = {
            database: target.database,
            schema: target.schema,
            tableName: target.objectName,
            object: tableRows[0] ?? null,
            columns: []
        };
        if (includeColumns) {
            result.columns = await this.queryRows(`
                SELECT ATTNAME AS COLUMN_NAME, DESCRIPTION, ATTNUM
                FROM ${prefix}_V_RELATION_COLUMN
                WHERE OBJID = (
                    SELECT OBJID FROM ${prefix}_V_OBJECT_DATA
                    WHERE DBNAME = ${escapeSqlLiteral(target.database)}
                      AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
                      AND UPPER(OBJNAME) = UPPER(${escapeSqlLiteral(target.objectName)})
                    LIMIT 1
                )
                ORDER BY ATTNUM
            `, target.database);
        }
        return JSON.stringify(result, JSON_SAFE_REPLACER, 2);
    }

    /** Returns PK/FK/UNIQUE metadata from _V_RELATION_KEYDATA. */
    async getTableConstraints(tableName: string, database?: string, schema?: string): Promise<string> {
        const referenceInput = schema && !tableName.includes('.')
            ? `${schema}.${tableName}`
            : tableName;
        const target = await this.resolveCatalogReference(
            referenceInput,
            database,
            ['TABLE']
        );
        const rows = await this.queryRows(`
            SELECT SCHEMA, RELATION, CONSTRAINTNAME, CONTYPE, ATTNAME,
                   PKDATABASE, PKSCHEMA, PKRELATION, PKATTNAME,
                   UPDT_TYPE, DEL_TYPE, CONSEQ
            FROM ${this.catalogPrefix(target.database)}_V_RELATION_KEYDATA
            WHERE UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})
              AND UPPER(RELATION) = UPPER(${escapeSqlLiteral(target.objectName)})
            ORDER BY CONSTRAINTNAME, CONSEQ
        `, target.database);

        const typeNames: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE' };
        const constraints = new Map<string, Record<string, unknown>>();
        for (const row of rows) {
            const name = String(row.CONSTRAINTNAME ?? '');
            if (!name) {
                continue;
            }
            const current = constraints.get(name) ?? {
                name,
                type: typeNames[String(row.CONTYPE ?? '').toLowerCase()] ?? String(row.CONTYPE ?? ''),
                columns: [],
                referenced: null,
                columnMappings: [],
                updateType: row.UPDT_TYPE ?? null,
                deleteType: row.DEL_TYPE ?? null
            };
            const localColumn = String(row.ATTNAME ?? '');
            (current.columns as string[]).push(localColumn);
            if (row.PKRELATION) {
                const referencedColumn = row.PKATTNAME ? String(row.PKATTNAME) : null;
                const referenced = (current.referenced as {
                    database: unknown;
                    schema: unknown;
                    tableName: unknown;
                    columnName?: string | null;
                    columns: string[];
                } | null) ?? {
                    database: row.PKDATABASE ?? null,
                    schema: row.PKSCHEMA ?? null,
                    tableName: row.PKRELATION,
                    columns: []
                };
                if (referencedColumn) {
                    referenced.columnName ??= referencedColumn;
                    referenced.columns.push(referencedColumn);
                    (current.columnMappings as Array<{ columnName: string; referencedColumnName: string }>).push({
                        columnName: localColumn,
                        referencedColumnName: referencedColumn
                    });
                }
                current.referenced = referenced;
            }
            constraints.set(name, current);
        }

        return JSON.stringify({
            database: target.database,
            schema: target.schema,
            tableName: target.objectName,
            constraints: Array.from(constraints.values())
        }, JSON_SAFE_REPLACER, 2);
    }

    /**
     * Returns direct FK and source-text dependencies for a catalog object.
     * View definitions are read on a connection to the target database, as
     * required by Netezza; procedure source is available from the catalog.
     */
    async getDependencies(
        object: string,
        database?: string,
        objectType?: string
    ): Promise<string> {
        const allowedTypes = objectType
            ? [objectType.trim().toUpperCase()]
            : ['TABLE', 'VIEW', 'PROCEDURE'];
        if (allowedTypes.some(type => !['TABLE', 'VIEW', 'PROCEDURE'].includes(type))) {
            throw new Error('objectType must be TABLE, VIEW or PROCEDURE.');
        }
        const target = await this.resolveAnyCatalogReference(object, database, allowedTypes);
        const prefix = this.catalogPrefix(target.database);
        const dependencies: Array<Record<string, unknown>> = [];
        const errors: string[] = [];
        const targetLiteral = escapeSqlLiteral(target.objectName);

        const addRows = (rows: Record<string, unknown>[], relationship: string): void => {
            for (const row of rows) {
                dependencies.push({ ...row, relationship });
            }
        };

        try {
            const fkRows = await this.queryRows(`
                SELECT SCHEMA, RELATION AS SOURCE_TABLE, CONSTRAINTNAME,
                       ATTNAME AS SOURCE_COLUMN, PKDATABASE, PKSCHEMA,
                       PKRELATION AS TARGET_TABLE, PKATTNAME AS TARGET_COLUMN,
                       UPDT_TYPE, DEL_TYPE
                FROM ${prefix}_V_RELATION_KEYDATA
                WHERE CONTYPE = 'f'
                  AND (
                    (UPPER(PKRELATION) = UPPER(${targetLiteral})
                     AND (PKSCHEMA IS NULL OR UPPER(PKSCHEMA) = UPPER(${escapeSqlLiteral(target.schema)})))
                    OR (UPPER(RELATION) = UPPER(${targetLiteral})
                        AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(target.schema)}))
                  )
                ORDER BY CONSTRAINTNAME, CONSEQ
            `, target.database);
            addRows(fkRows, 'FOREIGN_KEY');
        } catch (error: unknown) {
            errors.push(`foreign-key metadata: ${errorText(error)}`);
        }

        if (target.objectType === 'TABLE' || target.objectType === 'VIEW') {
            try {
                const viewRows = await this.queryRows(`
                    SELECT SCHEMA, VIEWNAME, OWNER, DEFINITION
                    FROM ${prefix}_V_VIEW
                    ORDER BY SCHEMA, VIEWNAME
                    LIMIT 100
                `, target.database);
                for (const row of viewRows) {
                    if (
                        String(row.VIEWNAME ?? '').toUpperCase() !== target.objectName
                        && sourceReferencesCatalogObject(String(row.DEFINITION ?? ''), target)
                    ) {
                        addRows([{
                            SCHEMA: row.SCHEMA,
                            VIEWNAME: row.VIEWNAME,
                            OWNER: row.OWNER
                        }], 'VIEW_SQL_REFERENCE');
                    }
                }
            } catch (error: unknown) {
                errors.push(`view source metadata: ${errorText(error)}`);
            }
        }

        try {
            const procedureRows = await this.queryRows(`
                SELECT SCHEMA, PROCEDURE AS PROCEDURE_NAME, OWNER, PROCEDURESOURCE
                FROM ${prefix}_V_PROCEDURE
                ORDER BY SCHEMA, PROCEDURE
                LIMIT 100
            `, target.database);
            for (const row of procedureRows) {
                if (sourceReferencesCatalogObject(String(row.PROCEDURESOURCE ?? ''), target)) {
                    addRows([{
                        SCHEMA: row.SCHEMA,
                        PROCEDURE_NAME: row.PROCEDURE_NAME,
                        OWNER: row.OWNER
                    }], 'PROCEDURE_SQL_REFERENCE');
                }
            }
        } catch (error: unknown) {
            errors.push(`procedure source metadata: ${errorText(error)}`);
        }

        const result: Record<string, unknown> = {
            target: {
                database: target.database,
                schema: target.schema,
                objectName: target.objectName,
                objectType: target.objectType
            },
            dependencies,
            counts: { total: dependencies.length },
            partial: errors.length > 0
        };
        if (errors.length > 0) {
            result.errors = errors;
        }
        return JSON.stringify(result, JSON_SAFE_REPLACER, 2);
    }

    /** Lists external tables and their external data object metadata. */
    async getExternalTables(database?: string, schema?: string, pattern?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            return 'No database specified and no active connection';
        }
        const upperDb = db.toUpperCase();
        const conditions = [`E1.DATABASE = ${escapeSqlLiteral(upperDb)}`];
        if (schema) {
            conditions.push(`UPPER(E1.SCHEMA) = UPPER(${escapeSqlLiteral(schema.toUpperCase())})`);
        }
        if (pattern) {
            conditions.push(`UPPER(E1.TABLENAME) LIKE UPPER(${escapeSqlLiteral(pattern)})`);
        }
        const rows = await this.queryRows(`
            SELECT E1.TABLENAME, E1.SCHEMA, E2.OWNER,
                   E1.DATABASE, E2.EXTOBJNAME AS DATAOBJECT,
                   E1.FORMAT, E1.REMOTESOURCE, E1.DELIM,
                   E1.SKIPROWS, E1.MAXERRORS
            FROM ${this.catalogPrefix(upperDb)}_V_EXTERNAL E1
            LEFT JOIN ${this.catalogPrefix(upperDb)}_V_EXTOBJECT E2 ON E1.RELID = E2.OBJID
            WHERE ${conditions.join('\n              AND ')}
            ORDER BY E1.SCHEMA, E1.TABLENAME
            LIMIT 200
        `, upperDb);
        return this.formatJson(rows, 'No external tables found');
    }

    /** Runs a gated EXPLAIN and returns structural plan analysis, not just text. */
    async analyzeQueryPlan(explainSql: string, database?: string): Promise<string> {
        const rawPlan = await this.explain(explainSql, database);
        const analysis = analyzeExplainPlanSemantic(rawPlan);
        return JSON.stringify({
            summary: analysis.summary,
            graph: { nodes: analysis.nodes, edges: analysis.edges },
            hotspots: analysis.hotspots,
            rawPlan
        }, JSON_SAFE_REPLACER, 2);
    }

    async getProcedures(database?: string, schema?: string): Promise<string> {
        const db = await this.resolveDatabase(database);
        if (!db) {
            return 'No database specified and no active connection';
        }
        const dbUpper = db.toUpperCase();
        let sql = `SELECT PROCEDURE, OWNER, RESULT AS RETURNS FROM ${escapeSqlIdentifier(dbUpper)}.._V_PROCEDURE WHERE DATABASE = ${escapeSqlLiteral(dbUpper)}`;
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

        db = this.normalizeCatalogIdentifier(db, 'Database');
        schemaName = this.normalizeCatalogIdentifier(schemaName, 'Schema');
        objectName = this.normalizeCatalogIdentifier(objectName, 'Object name');

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
