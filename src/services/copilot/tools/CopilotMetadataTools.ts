import { ConnectionManager } from '../../../core/connectionManager';

interface CopilotMetadataToolsDeps {
    connectionManager: ConnectionManager;
    runQuerySafe: (sql: string, description: string) => Promise<string>;
}

export class CopilotMetadataTools {
    constructor(private readonly deps: CopilotMetadataToolsDeps) { }

    async getDatabases(): Promise<string> {
        const sql = 'SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE';
        return this.deps.runQuerySafe(sql, 'fetch databases');
    }

    async getSchemas(database?: string): Promise<string> {
        // Get current database if not specified
        let db = database;
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            // Fallback to _V_USER which is global
            const sql = 'SELECT USERNAME as SCHEMA_NAME FROM _V_USER ORDER BY USERNAME';
            return this.deps.runQuerySafe(sql, 'fetch schemas');
        }
        // Use cross-database syntax for database-specific schemas
        const sql = `SELECT SCHEMA_NAME FROM ${db.toUpperCase()}.._V_SCHEMA ORDER BY SCHEMA_NAME`;
        return this.deps.runQuerySafe(sql, 'fetch schemas');
    }

    async getProcedures(database?: string, schema?: string): Promise<string> {
        // Get current database if not specified
        let db = database;
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        // Use cross-database syntax: DB.._V_PROCEDURE
        const dbUpper = db.toUpperCase();
        let sql = `SELECT PROCEDURE, OWNER, RETURNS, BILTIN FROM ${dbUpper}.._V_PROCEDURE WHERE DATABASE = '${dbUpper}' AND BILTIN = 'f'`;
        if (schema) {
            sql += ` AND OWNER = '${schema.toUpperCase()}'`;
        }
        sql += ' ORDER BY PROCEDURE LIMIT 200';
        return this.deps.runQuerySafe(sql, 'fetch procedures');
    }

    async getViews(database?: string, schema?: string): Promise<string> {
        // Get current database if not specified
        let db = database;
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        // Use cross-database syntax: DB.._V_VIEW
        const dbUpper = db.toUpperCase();
        let sql = `SELECT VIEWNAME, OWNER FROM ${dbUpper}.._V_VIEW WHERE DATABASE = '${dbUpper}' AND VIEWNAME NOT LIKE '_v_%'`;
        if (schema) {
            sql += ` AND OWNER = '${schema.toUpperCase()}'`;
        }
        sql += ' ORDER BY VIEWNAME LIMIT 200';
        return this.deps.runQuerySafe(sql, 'fetch views');
    }

    async getExternalTables(database?: string, schema?: string, pattern?: string): Promise<string> {
        // Get current database if not specified
        let db = database;
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        // Use cross-database syntax: DB.._V_EXTERNAL_TABLE
        const dbUpper = db.toUpperCase();
        let sql = `SELECT TABLENAME, OWNER FROM ${dbUpper}.._V_EXTERNAL_TABLE WHERE DATABASE = '${dbUpper}'`;
        const conditions: string[] = [];
        if (schema) conditions.push(`OWNER = '${schema.toUpperCase()}'`);
        if (pattern) conditions.push(`TABLENAME LIKE '${pattern.toUpperCase()}'`);

        if (conditions.length > 0) {
            sql += ` AND ${conditions.join(' AND ')}`;
        }
        sql += ' ORDER BY TABLENAME LIMIT 200';
        return this.deps.runQuerySafe(sql, 'fetch external tables');
    }

}
