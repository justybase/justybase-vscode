/**
 * Schema Commands - Table Modification Commands
 * Commands: addPrimaryKey, addTableComment, addColumnComment, truncateTable,
 *           renameTable, changeOwner, grantPermissions, alterTableWizard
 */

import * as vscode from 'vscode';
import { runQuery } from '../../core/queryRunner';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName, requireConnection, executeWithProgress, escapeSqlString, isValidIdentifier } from './helpers';
import { TableDesignerView } from '../../views/tableDesignerView';

/**
 * Register table modification commands
 */
export function registerTableCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, metadataCache, schemaProvider } = deps;

    return [
        // Create Table via Visual Designer
        vscode.commands.registerCommand('netezza.createTableDesigner', async (item: SchemaItemData) => {
            if (!item || (!item.dbName && !item.schema)) {
                vscode.window.showErrorMessage('Invalid selection. Select a Table folder, Schema, or Database.');
                return;
            }

            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            const dbName = item.dbName || 'SYSTEM';
            const schemaName = databaseKind === 'sqlite' ? item.schema : item.schema || 'ADMIN';
            const connectionName = item.connectionName;

            if (!await requireConnection(connectionManager)) return;

            TableDesignerView.createOrShow(
                context,
                connectionManager,
                dbName,
                schemaName,
                connectionName
            );
        }),

        // Alter Table Wizard
        vscode.commands.registerCommand('netezza.alterTableWizard', async (item: SchemaItemData) => {
            if (!item || !item.label || !item.dbName || !item.schema || (item.objType && item.objType !== 'TABLE')) {
                vscode.window.showErrorMessage('Invalid selection. Select a table.');
                return;
            }

            const targetDatabase = item.dbName;
            const targetSchema = item.schema;
            const fullName = getFullName(item, connectionManager);
            const operations: Array<vscode.QuickPickItem & { id: string; destructive?: boolean }> = [
                {
                    id: 'add-column',
                    label: '$(add) Add Column',
                    description: 'ALTER TABLE ... ADD COLUMN'
                },
                {
                    id: 'rename-column',
                    label: '$(edit) Rename Column',
                    description: 'ALTER TABLE ... RENAME COLUMN ... TO ...'
                },
                {
                    id: 'drop-column',
                    label: '$(trash) Drop Column',
                    description: 'ALTER TABLE ... DROP COLUMN',
                    destructive: true
                },
                {
                    id: 'set-not-null',
                    label: '$(check) Set NOT NULL',
                    description: 'ALTER TABLE ... ALTER COLUMN ... SET NOT NULL'
                },
                {
                    id: 'drop-not-null',
                    label: '$(close) Drop NOT NULL',
                    description: 'ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL'
                },
                {
                    id: 'set-default',
                    label: '$(symbol-value) Set DEFAULT',
                    description: 'ALTER TABLE ... ALTER COLUMN ... SET DEFAULT ...'
                },
                {
                    id: 'drop-default',
                    label: '$(symbol-null) Drop DEFAULT',
                    description: 'ALTER TABLE ... ALTER COLUMN ... DROP DEFAULT'
                }
            ];

            const operation = await vscode.window.showQuickPick(operations, {
                title: `Alter Table Wizard (${fullName})`,
                placeHolder: 'Select ALTER TABLE operation'
            });

            if (!operation) return;

            const getColumnName = async (prompt: string, placeHolder = 'e.g. COLUMN_NAME', value?: string): Promise<string | undefined> => {
                const columnName = await vscode.window.showInputBox({
                    prompt,
                    placeHolder,
                    value,
                    validateInput: input => {
                        if (!input || input.trim().length === 0) {
                            return 'Column name cannot be empty';
                        }
                        if (!isValidIdentifier(input.trim())) {
                            return 'Invalid column name. Use only letters, numbers, and underscores.';
                        }
                        return null;
                    }
                });
                return columnName ? columnName.trim().toUpperCase() : undefined;
            };

            let sql = '';
            switch (operation.id) {
                case 'add-column': {
                    const columnName = await getColumnName('Enter new column name');
                    if (!columnName) return;
                    const columnType = await vscode.window.showInputBox({
                        prompt: 'Enter column data type',
                        placeHolder: 'e.g. VARCHAR(100), INTEGER, TIMESTAMP',
                        validateInput: input => {
                            if (!input || input.trim().length === 0) {
                                return 'Data type cannot be empty';
                            }
                            return null;
                        }
                    });
                    if (!columnType) return;
                    sql = `ALTER TABLE ${fullName} ADD COLUMN ${columnName} ${columnType.trim()};`;
                    break;
                }
                case 'rename-column': {
                    const currentName = await getColumnName('Enter current column name');
                    if (!currentName) return;
                    const newName = await getColumnName('Enter new column name', 'e.g. NEW_COLUMN_NAME');
                    if (!newName) return;
                    if (currentName === newName) {
                        vscode.window.showInformationMessage('New column name is the same as current name. No changes applied.');
                        return;
                    }
                    sql = `ALTER TABLE ${fullName} RENAME COLUMN ${currentName} TO ${newName};`;
                    break;
                }
                case 'drop-column': {
                    const columnName = await getColumnName('Enter column name to drop');
                    if (!columnName) return;
                    const dropBehavior = await vscode.window.showQuickPick(
                        [
                            { label: 'RESTRICT', description: 'Fail if objects depend on the column' },
                            { label: 'CASCADE', description: 'Drop dependent objects automatically' }
                        ],
                        { placeHolder: 'Select drop behavior (RESTRICT or CASCADE)' }
                    );
                    if (!dropBehavior) return;
                    sql = `ALTER TABLE ${fullName} DROP COLUMN ${columnName} ${dropBehavior.label};`;
                    break;
                }
                case 'set-not-null': {
                    const columnName = await getColumnName('Enter column name to enforce NOT NULL');
                    if (!columnName) return;
                    sql = `ALTER TABLE ${fullName} ALTER COLUMN ${columnName} SET NOT NULL;`;
                    break;
                }
                case 'drop-not-null': {
                    const columnName = await getColumnName('Enter column name to allow NULL values');
                    if (!columnName) return;
                    sql = `ALTER TABLE ${fullName} ALTER COLUMN ${columnName} DROP NOT NULL;`;
                    break;
                }
                case 'set-default': {
                    const columnName = await getColumnName('Enter column name for DEFAULT value');
                    if (!columnName) return;
                    const defaultExpr = await vscode.window.showInputBox({
                        prompt: 'Enter DEFAULT SQL expression',
                        placeHolder: "e.g. 0, 'ACTIVE', CURRENT_TIMESTAMP",
                        validateInput: input => {
                            if (!input || input.trim().length === 0) {
                                return 'Default expression cannot be empty';
                            }
                            return null;
                        }
                    });
                    if (!defaultExpr) return;
                    sql = `ALTER TABLE ${fullName} ALTER COLUMN ${columnName} SET DEFAULT ${defaultExpr.trim()};`;
                    break;
                }
                case 'drop-default': {
                    const columnName = await getColumnName('Enter column name to drop DEFAULT value');
                    if (!columnName) return;
                    sql = `ALTER TABLE ${fullName} ALTER COLUMN ${columnName} DROP DEFAULT;`;
                    break;
                }
                default:
                    return;
            }

            if (!sql) return;

            const previewAction = operation.destructive
                ? await vscode.window.showWarningMessage(
                    `⚠️ This operation may be destructive:\n\n${sql}`,
                    { modal: true },
                    'Execute',
                    'Open in Editor',
                    'Cancel'
                )
                : await vscode.window.showInformationMessage(
                    `Review ALTER TABLE statement:\n\n${sql}`,
                    { modal: true },
                    'Execute',
                    'Open in Editor',
                    'Cancel'
                );

            if (previewAction === 'Open in Editor') {
                const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
                await vscode.window.showTextDocument(doc);
                return;
            }

            if (previewAction !== 'Execute') return;
            if (!await requireConnection(connectionManager)) return;

            try {
                await executeWithProgress(
                    `Executing ALTER TABLE on ${fullName}...`,
                    async () => {
                        await runQuery(context, sql, true, item.connectionName, connectionManager);
                    }
                );

                vscode.window.showInformationMessage(`ALTER TABLE executed successfully on ${fullName}.`);
                if (item.connectionName) {
                    metadataCache.invalidateSchema(item.connectionName, targetDatabase, targetSchema);
                }
                schemaProvider.refresh();
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error executing ALTER TABLE: ${message}`);
            }
        }),

        // Grant Permissions
        vscode.commands.registerCommand('netezza.grantPermissions', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType) {
                const fullName = getFullName(item, connectionManager);

                const privilege = await vscode.window.showQuickPick(
                    [
                        { label: 'SELECT', description: 'Privileges to read data' },
                        { label: 'INSERT', description: 'Privileges to insert data' },
                        { label: 'UPDATE', description: 'Privileges to update data' },
                        { label: 'DELETE', description: 'Privileges to delete data' },
                        { label: 'ALL', description: 'All privileges (SELECT, INSERT, UPDATE, DELETE)' },
                        { label: 'LIST', description: 'Privileges to list objects' }
                    ],
                    {
                        placeHolder: 'Select privilege type'
                    }
                );

                if (!privilege) return;

                const grantee = await vscode.window.showInputBox({
                    prompt: 'Enter user or group name',
                    placeHolder: 'e.g. SOME_USER or GROUP_NAME',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'User/group name cannot be empty';
                        }
                        if (!isValidIdentifier(value)) {
                            return 'Invalid user/group name';
                        }
                        return null;
                    }
                });

                if (!grantee) return;

                const sql = `GRANT ${privilege.label} ON ${fullName} TO ${grantee.trim().toUpperCase()};`;

                const confirmation = await vscode.window.showInformationMessage(
                    `Execute: ${sql}`,
                    { modal: true },
                    'Yes, execute',
                    'Cancel'
                );

                if (confirmation === 'Yes, execute') {
                    if (!await requireConnection(connectionManager)) return;

                    try {
                        await executeWithProgress(
                            `Granting ${privilege.label} on ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(
                            `Granted ${privilege.label} on ${fullName} to ${grantee.trim().toUpperCase()}`
                        );
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error granting privileges: ${message}`);
                    }
                }
            }
        }),

        // Add Table Comment
        vscode.commands.registerCommand('netezza.addTableComment', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const comment = await vscode.window.showInputBox({
                    prompt: 'Enter comment for table',
                    placeHolder: 'e.g. Table contains customer data',
                    value: item.objectDescription || ''
                });

                if (comment === undefined) return;

                const sql = `COMMENT ON TABLE ${fullName} IS '${escapeSqlString(comment)}';`;

                try {
                    if (!await requireConnection(connectionManager)) return;

                    await runQuery(context, sql, true, item.connectionName, connectionManager);
                    vscode.window.showInformationMessage(`Comment added to table: ${fullName}`);
                    schemaProvider.refresh();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error adding comment: ${message}`);
                }
            }
        }),

        // Add Column Comment
        vscode.commands.registerCommand('netezza.addColumnComment', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.parentName) {
                const colName = item.label.split(' ')[0];
                const tableName = item.parentName;
                const schemaName = item.schema || 'ADMIN';
                const fullColumnRef = `${item.dbName}.${schemaName}.${tableName}.${colName}`;

                const comment = await vscode.window.showInputBox({
                    prompt: `Enter comment for column "${colName}"`,
                    placeHolder: 'e.g. Customer ID from CRM',
                    value: item.objectDescription || ''
                });

                if (comment === undefined) return;

                const sql = `COMMENT ON COLUMN ${fullColumnRef} IS '${escapeSqlString(comment)}';`;

                try {
                    if (!await requireConnection(connectionManager)) return;

                    await runQuery(context, sql, true, item.connectionName, connectionManager);
                    vscode.window.showInformationMessage(`Comment added to column: ${colName}`);
                    schemaProvider.refresh();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error adding comment: ${message}`);
                }
            }
        }),

        // Truncate Table
        vscode.commands.registerCommand('netezza.truncateTable', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);
                const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
                const sql = databaseKind === 'sqlite' ? `DELETE FROM ${fullName};` : `TRUNCATE TABLE ${fullName};`;

                const confirmation = await vscode.window.showWarningMessage(
                    `⚠️ WARNING: Are you sure you want to delete ALL data from the table "${fullName}"?\n\n${sql}\n\nThis operation is IRREVERSIBLE!`,
                    { modal: true },
                    'Yes, delete all data',
                    'Cancel'
                );

                if (confirmation === 'Yes, delete all data') {
                    if (!await requireConnection(connectionManager)) return;

                    try {
                        await executeWithProgress(
                            `Clearing table ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(`Table cleared: ${fullName}`);
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error clearing table: ${message}`);
                    }
                }
            }
        }),

        // Add Primary Key
        vscode.commands.registerCommand('netezza.addPrimaryKey', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const constraintName = await vscode.window.showInputBox({
                    prompt: 'Enter primary key constraint name',
                    placeHolder: `e.g. PK_${item.label}`,
                    value: `PK_${item.label}`,
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'Constraint name cannot be empty';
                        }
                        if (!isValidIdentifier(value)) {
                            return 'Invalid constraint name';
                        }
                        return null;
                    }
                });

                if (!constraintName) return;

                const columns = await vscode.window.showInputBox({
                    prompt: 'Enter primary key column names (comma separated)',
                    placeHolder: 'e.g. COL1, COL2 or ID',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'You must provide at least one column';
                        }
                        return null;
                    }
                });

                if (!columns) return;

                const columnList = columns
                    .split(',')
                    .map(c => c.trim().toUpperCase())
                    .join(', ');
                const sql = `ALTER TABLE ${fullName} ADD CONSTRAINT ${constraintName.trim().toUpperCase()} PRIMARY KEY (${columnList});`;

                const confirmation = await vscode.window.showInformationMessage(
                    `Add primary key to table "${fullName}"?\n\n${sql}`,
                    { modal: true },
                    'Yes, add',
                    'Cancel'
                );

                if (confirmation === 'Yes, add') {
                    if (!await requireConnection(connectionManager)) return;

                    try {
                        await executeWithProgress(
                            `Adding primary key to ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(
                            `Primary key added: ${constraintName.trim().toUpperCase()}`
                        );
                        schemaProvider.refresh();
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error adding primary key: ${message}`);
                    }
                }
            }
        }),

        // Add Foreign Key
        vscode.commands.registerCommand('netezza.addForeignKey', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const constraintName = await vscode.window.showInputBox({
                    prompt: 'Enter foreign key constraint name',
                    placeHolder: `e.g. FK_${item.label}`,
                    value: `FK_${item.label}`,
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'Constraint name cannot be empty';
                        }
                        if (!isValidIdentifier(value)) {
                            return 'Invalid constraint name';
                        }
                        return null;
                    }
                });

                if (!constraintName) return;

                const columns = await vscode.window.showInputBox({
                    prompt: 'Enter foreign key column names (comma separated)',
                    placeHolder: 'e.g. COL1, COL2 or ID',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'You must provide at least one column';
                        }
                        return null;
                    }
                });

                if (!columns) return;

                const referencedTable = await vscode.window.showInputBox({
                    prompt: 'Enter referenced table name (schema.table)',
                    placeHolder: 'e.g. SCHEMA_NAME.TABLE_NAME',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'Referenced table name cannot be empty';
                        }
                        return null;
                    }
                });

                if (!referencedTable) return;

                const referencedColumns = await vscode.window.showInputBox({
                    prompt: 'Enter referenced table column names (comma separated)',
                    placeHolder: 'e.g. COL1, COL2 or ID',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'You must provide at least one column';
                        }
                        return null;
                    }
                });

                if (!referencedColumns) return;

                const columnList = columns
                    .split(',')
                    .map(c => c.trim().toUpperCase())
                    .join(', ');
                const refColumnList = referencedColumns
                    .split(',')
                    .map(c => c.trim().toUpperCase())
                    .join(', ');
                const sql = `ALTER TABLE ${fullName} ADD CONSTRAINT ${constraintName.trim().toUpperCase()} FOREIGN KEY (${columnList}) REFERENCES ${referencedTable.trim().toUpperCase()} (${refColumnList});`;

                const confirmation = await vscode.window.showInformationMessage(
                    `Add foreign key to table "${fullName}"?\n\n${sql}`,
                    { modal: true },
                    'Yes, add',
                    'Cancel'
                );

                if (confirmation === 'Yes, add') {
                    if (!await requireConnection(connectionManager)) return;

                    try {
                        await executeWithProgress(
                            `Adding foreign key to ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(
                            `Foreign key added: ${constraintName.trim().toUpperCase()}`
                        );
                        schemaProvider.refresh();
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error adding foreign key: ${message}`);
                    }
                }
            }
        }),

        // Add Unique Constraint
        vscode.commands.registerCommand('netezza.addUniqueConstraint', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const constraintName = await vscode.window.showInputBox({
                    prompt: 'Enter unique constraint name',
                    placeHolder: `e.g. UQ_${item.label}`,
                    value: `UQ_${item.label}`,
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'Constraint name cannot be empty';
                        }
                        if (!isValidIdentifier(value)) {
                            return 'Invalid constraint name';
                        }
                        return null;
                    }
                });

                if (!constraintName) return;

                const columns = await vscode.window.showInputBox({
                    prompt: 'Enter unique constraint column names (comma separated)',
                    placeHolder: 'e.g. COL1, COL2 or EMAIL',
                    validateInput: value => {
                        if (!value || value.trim().length === 0) {
                            return 'You must provide at least one column';
                        }
                        return null;
                    }
                });

                if (!columns) return;

                const columnList = columns
                    .split(',')
                    .map(c => c.trim().toUpperCase())
                    .join(', ');
                const sql = `ALTER TABLE ${fullName} ADD CONSTRAINT ${constraintName.trim().toUpperCase()} UNIQUE (${columnList});`;

                const confirmation = await vscode.window.showInformationMessage(
                    `Add unique constraint to table "${fullName}"?\n\n${sql}`,
                    { modal: true },
                    'Yes, add',
                    'Cancel'
                );

                if (confirmation === 'Yes, add') {
                    if (!await requireConnection(connectionManager)) return;

                    try {
                        await executeWithProgress(
                            `Adding unique constraint to ${fullName}...`,
                            async () => {
                                await runQuery(context, sql, true, item.connectionName, connectionManager);
                            }
                        );

                        vscode.window.showInformationMessage(
                            `Unique constraint added: ${constraintName.trim().toUpperCase()}`
                        );
                        schemaProvider.refresh();
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Error adding unique constraint: ${message}`);
                    }
                }
            }
        }),

        // Change Owner
        vscode.commands.registerCommand('netezza.changeOwner', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const newOwner = await vscode.window.showInputBox({
                    prompt: 'Enter new owner name',
                    placeHolder: 'e.g. USER_NAME or GROUP_NAME'
                });

                if (!newOwner) return;

                const sql = `ALTER TABLE ${fullName} OWNER TO ${newOwner.trim()};`;

                try {
                    if (!await requireConnection(connectionManager)) return;

                    await runQuery(context, sql, true, item.connectionName, connectionManager);
                    vscode.window.showInformationMessage(`Owner changed to ${newOwner} for ${fullName}`);

                    metadataCache.invalidateSchema(item.connectionName!, item.dbName, item.schema);
                    schemaProvider.refresh();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error changing owner: ${message}`);
                }
            }
        }),

        // Rename Table
        vscode.commands.registerCommand('netezza.renameTable', async (item: SchemaItemData) => {
            if (item && item.label && item.dbName && item.schema && item.objType === 'TABLE') {
                const fullName = getFullName(item, connectionManager);

                const newName = await vscode.window.showInputBox({
                    prompt: 'Enter new table name',
                    placeHolder: 'NewTableName',
                    value: item.label
                });

                if (!newName || newName === item.label) return;

                const sql = `ALTER TABLE ${fullName} RENAME TO ${newName.trim()};`;

                try {
                    if (!await requireConnection(connectionManager)) return;

                    await runQuery(context, sql, true, item.connectionName, connectionManager);
                    vscode.window.showInformationMessage(`Table renamed to ${newName}`);

                    metadataCache.invalidateSchema(item.connectionName!, item.dbName, item.schema);
                    schemaProvider.refresh();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error renaming table: ${message}`);
                }
            }
        })
    ];
}
