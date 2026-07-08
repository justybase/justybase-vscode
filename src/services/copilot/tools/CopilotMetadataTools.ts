import { ConnectionManager } from '../../../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery
} from '../../../core/connectionFactory';

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

    async getObjectDefinition(objectName: string, objectType: 'view' | 'procedure', database?: string): Promise<string> {
        // Parse object name to extract database if provided in format DB.SCHEMA.OBJECT
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

        // Get database from parameter or current connection
        if (!db) {
            db = database?.toUpperCase();
        }
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        if (objectType === 'view') {
            // CRITICAL: View DEFINITION is only accessible when connected TO THE SAME DATABASE
            // Cross-database query (DB.._V_VIEW) will return NULL for DEFINITION column
            // We must establish a dedicated connection to the target database
            return this.getViewDefinitionWithDedicatedConnection(db, objName);
        } else {
            // Procedures can be queried cross-database - PROCEDURESOURCE is accessible
            const sql = `SELECT PROCEDURESIGNATURE, RETURNS, PROCEDURESOURCE FROM ${db}.._V_PROCEDURE WHERE DATABASE = '${db}' AND PROCEDURE = '${objName}'`;
            return this.deps.runQuerySafe(sql, 'fetch definition');
        }
    }

    /**
     * Get view definition using a dedicated connection to the target database.
     * This is required because DEFINITION column is only accessible when connected
     * to the same database where the view exists.
     */
    private async getViewDefinitionWithDedicatedConnection(database: string, viewName: string): Promise<string> {
        const connectionName = this.deps.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            return 'No active connection';
        }

        const connectionDetails = await this.deps.connectionManager.getConnection(connectionName);
        if (!connectionDetails) {
            return `Connection "${connectionName}" not found.`;
        }

        // Create dedicated connection to the target database
        const connection = await createConnectedDatabaseConnectionFromDetails({
            ...connectionDetails,
            database: database
        });

        if (!connection) {
            return `Could not establish connection to database "${database}".`;
        }

        try {
            const sql = `SELECT DEFINITION FROM _V_VIEW WHERE DATABASE = '${database}' AND VIEWNAME = '${viewName}'`;
            const result = await executeDatabaseQuery<{ DEFINITION: string }>(connection, sql);
            if (result && result.length > 0 && result[0].DEFINITION) {
                return result[0].DEFINITION;
            }
            return `View "${viewName}" not found in database "${database}" or has no definition.`;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Error fetching view definition: ${msg}`;
        } finally {
            await connection.close();
        }
    }
}
