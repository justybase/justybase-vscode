// import * as odbc from 'odbc'; // Removed odbc dependency
import {
    createConnectedDatabaseConnectionFromDetails,
    getRequiredDatabaseDdlProvider
} from '../core/connectionFactory';

export interface RecreateTableResult {
    success: boolean;
    sqlScript?: string;
    error?: string;
}

import { NzConnection, ConnectionDetails } from '../types';

// ConnectionDetails imported from types - no parseConnectionString needed

export async function generateRecreateTableScript(
    connectionDetails: ConnectionDetails,
    database: string,
    schema: string,
    tableName: string,
    newTableNameInput: string | undefined
): Promise<RecreateTableResult> {
    let connection: NzConnection | null = null;
    const ddlProvider = getRequiredDatabaseDdlProvider(connectionDetails.dbType);

    try {
        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;

        // 1. Get Metadata
        const columns = await ddlProvider.getColumns(connection, database, schema, tableName);
        if (columns.length === 0) {
            return { success: false, error: `Table ${database}.${schema}.${tableName} not found or has no columns` };
        }

        const distributionColumns = await ddlProvider.getDistributionInfo(connection, database, schema, tableName);
        const organizeColumns = await ddlProvider.getOrganizeInfo(connection, database, schema, tableName);
        const keysInfo = await ddlProvider.getKeysInfo(connection, database, schema, tableName);
        const tableComment = await ddlProvider.getTableComment(connection, database, schema, tableName);
        const owner = await ddlProvider.getTableOwner(connection, database, schema, tableName);

        // 2. Prepare Names
        const cleanDatabase = ddlProvider.quoteNameIfNeeded(database);
        const cleanSchema = ddlProvider.quoteNameIfNeeded(schema);
        const cleanTableName = ddlProvider.quoteNameIfNeeded(tableName);


        // Generate a unique suffix for the temp table
        const timestamp = new Date()
            .toISOString()
            .replace(/[-:T.]/g, '')
            .substring(0, 14);
        const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();

        // The user might have provided a specific name for the new table structure (maybe to change columns?)
        // But usually "Recreate Table" implies keeping same structure but maybe changing distribution/organization
        // effectively doing a deep vacuum / re-ordering.
        // IF the user input a name, we use it. If not, we generate one.
        // In this implementation, let's assume we are creating the "Target" table which will eventually become the main table.

        const tempTableName = newTableNameInput ? newTableNameInput : `${tableName}_${timestamp}_NEW`;

        const cleanTempTableName = ddlProvider.quoteNameIfNeeded(tempTableName);

        const backupTableName = `${tableName}_${timestamp}_BACKUP_${randomSuffix}`; // "TUWZHYOFPD" part in example
        const cleanBackupTableName = ddlProvider.quoteNameIfNeeded(backupTableName);

        // 3. Build Script
        const lines: string[] = [];

        // Header
        lines.push(`-- Recreate Table Script for ${cleanDatabase}.${cleanSchema}.${cleanTableName}`);
        lines.push('');

        // CREATE NEW TABLE
        lines.push(`-- 1. Create new table with desired structure`);
        lines.push(`CREATE TABLE ${cleanDatabase}.${cleanSchema}.${cleanTempTableName}`);
        lines.push('(');

        const columnDefinitions: string[] = [];
        for (const column of columns) {
            const cleanColumnName = ddlProvider.quoteNameIfNeeded(column.name);
            let columnDef = `    ${cleanColumnName} ${column.fullTypeName}`;
            if (column.notNull) columnDef += ' NOT NULL';
            if (column.defaultValue !== null) columnDef += ` DEFAULT ${column.defaultValue}`;
            columnDefinitions.push(columnDef);
        }
        lines.push(columnDefinitions.join(',\n'));

        // Distribution
        if (distributionColumns.length > 0) {
            const cleanDistColumns = distributionColumns.map(col => ddlProvider.quoteNameIfNeeded(col));
            lines.push(`)\nDISTRIBUTE ON (${cleanDistColumns.join(', ')})`);
        } else {
            lines.push(')\nDISTRIBUTE ON RANDOM');
        }

        // Organization
        if (organizeColumns.length > 0) {
            const cleanOrgColumns = organizeColumns.map(col => ddlProvider.quoteNameIfNeeded(col));
            lines.push(`ORGANIZE ON (${cleanOrgColumns.join(', ')})`);
        }
        lines.push(';');
        lines.push('');

        // INSERT DATA
        lines.push(`-- 2. Copy data from original table`);
        lines.push(
            `INSERT INTO ${cleanDatabase}.${cleanSchema}.${cleanTempTableName} SELECT * FROM ${cleanDatabase}.${cleanSchema}.${cleanTableName};`
        );
        lines.push('');

        // TRANSFER PRIVILEGES
        lines.push(`-- 3. Copy privileges from original table`);
        lines.push(
            `ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTempTableName} SET PRIVILEGES TO ${cleanDatabase}.${cleanSchema}.${cleanTableName};`
        );
        lines.push('');

        // RENAME SWAP
        lines.push(`-- 4. Swap tables: Rename Original to Backup, New to Original`);
        lines.push(`ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} RENAME TO ${cleanBackupTableName};`);
        lines.push(`ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTempTableName} RENAME TO ${cleanTableName};`);
        lines.push('');

        // RESTORE OWNER
        if (owner) {
            const cleanOwner = ddlProvider.quoteNameIfNeeded(owner);
            lines.push(`-- 5. Restore Owner`);
            lines.push(`ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} OWNER TO ${cleanOwner};`);
            lines.push('');
        }

        // DROP BACKUP
        lines.push(`-- 6. Drop Backup Table (Optional - Comment out if you want to keep it)`);
        lines.push(`DROP TABLE ${cleanDatabase}.${cleanSchema}.${cleanBackupTableName};`);
        lines.push('');

        // RESTORE PK/CONSTRAINTS
        // Note: SET PRIVILEGES might handle some things but constraints usually need explicit re-creation on the new physical table
        // Constraints are on the *table object*, so the new table needs them added.
        if (keysInfo.size > 0) {
            lines.push(`-- 7. Restore Constraints`);
            for (const [keyName, keyInfo] of keysInfo) {
                // We typically need to generate a new name for the constraint if it needs to be unique globally or per schema
                // But since we dropped/renamed the old one, we might be able to reuse the name?
                // Netezza constraint names: If we renamed the old table, the constraints moved with it?
                // Actually constraint names often are unique.
                // Best practice: Let Netezza auto-name or use the old name since the old table is renamed/dropped?
                // If we explicitly named them before, we want to keep that name.
                // But the old table (now backup) still holds the constraint with that name if we didn't drop it yet.
                // The script drops the backup table before adding constraints basically?
                // Or we rely on the user executing the DROP.

                // If we reuse the name, we might collision if backup exists.
                // Let's use the original name logic.

                const cleanKeyName = ddlProvider.quoteNameIfNeeded(keyName);
                const cleanColumns = keyInfo.columns.map(col => ddlProvider.quoteNameIfNeeded(col));

                let constraintSql = '';

                if (keyInfo.typeChar === 'f') {
                    // Foreign Key
                    const cleanPkColumns = keyInfo.pkColumns
                        .filter(col => col)
                        .map(col => ddlProvider.quoteNameIfNeeded(col));
                    if (cleanPkColumns.length > 0 && keyInfo.pkDatabase && keyInfo.pkSchema && keyInfo.pkRelation) {
                        const cleanPkDatabase = ddlProvider.quoteNameIfNeeded(keyInfo.pkDatabase);
                        const cleanPkSchema = ddlProvider.quoteNameIfNeeded(keyInfo.pkSchema);
                        const cleanPkRelation = ddlProvider.quoteNameIfNeeded(keyInfo.pkRelation);
                        constraintSql =
                            `ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} ` +
                            `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} ` +
                            `(${cleanColumns.join(', ')}) ` +
                            `REFERENCES ${cleanPkDatabase}.${cleanPkSchema}.${cleanPkRelation} ` +
                            `(${cleanPkColumns.join(', ')}) ` +
                            `ON DELETE ${keyInfo.deleteType} ON UPDATE ${keyInfo.updateType};`;
                    }
                } else if (keyInfo.typeChar === 'p' || keyInfo.typeChar === 'u') {
                    // Primary Key or Unique
                    constraintSql =
                        `ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} ` +
                        `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} ` +
                        `(${cleanColumns.join(', ')});`;
                }

                if (constraintSql) {
                    lines.push(constraintSql);
                }
            }
            lines.push('');
        }

        // RESTORE COMMENTS
        if (tableComment) {
            const cleanComment = tableComment.replace(/'/g, "''");
            lines.push(`-- 8. Restore Comments`);
            lines.push(`COMMENT ON TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} IS '${cleanComment}';`);
        }

        const columnComments: string[] = [];
        for (const col of columns) {
            if (col.description) {
                const cleanColName = ddlProvider.quoteNameIfNeeded(col.name);
                const cleanDesc = col.description.replace(/'/g, "''");
                columnComments.push(
                    `COMMENT ON COLUMN ${cleanDatabase}.${cleanSchema}.${cleanTableName}.${cleanColName} IS '${cleanDesc}';`
                );
            }
        }

        if (columnComments.length > 0) {
            if (!tableComment) lines.push(`-- 8. Restore Comments`);
            lines.push(columnComments.join('\n'));
            lines.push('');
        }

        // GENERATE STATS
        lines.push(`-- 9. Generate Statistics`);
        lines.push(`GENERATE EXPRESS STATISTICS ON ${cleanDatabase}.${cleanSchema}.${cleanTableName};`);

        return {
            success: true,
            sqlScript: lines.join('\n')
        };
    } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        return {
            success: false,
            error: `Error generating recreate script: ${errorMsg}`
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore connection close errors during cleanup
            }
        }
    }
}
