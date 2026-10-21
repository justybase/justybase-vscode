/**
 * Schema Commands - Data Exploration Operations
 *
 * Commands: countRows, findDuplicateRows, createTableFromTable,
 *           callRoutine, setTableStorage, searchSchemaValues
 *
 * SQL builders live in ./menuSql (ported from the Tauri SchemaBrowser so
 * both shells generate identical dialect-specific statements).
 */

import * as vscode from 'vscode';
import { runQuery } from '../../core/queryRunner';
import type { DatabaseKind } from '../../contracts/database';
import { getTablesForScope } from '../../metadata/cache/schemaTreeDataSource';
import { buildColumnCacheKey } from '../../metadata/columnRowMapping';
import {
    buildNetezzaCacheDatabasePart,
    decodeNetezzaCacheDatabasePart,
    isNetezzaExactCachePart,
} from '../../metadata/helpers';
import {
    isNetezzaQuotedIdentifier,
    unquoteNetezzaIdentifier,
} from '../../dialects/netezza/metadata/identifierUtils';
import type { ColumnMetadata } from '../../metadata/types';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../utils/identifierUtils';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName, getItemObjectName, isValidIdentifier, executeWithProgress, openAndRunSql } from './helpers';
import {
    alterColumnSql,
    callRoutineSql,
    countRowsSql,
    createIndexSql,
    createTableFromSql,
    duplicateRowsSql,
    isSafeSqlDataType,
    postgresTableStorageSql,
    quoteIdentifierListForKind,
    schemaValueSearchSql,
    supportsSchemaValueSearch,
    SELECTABLE_SCHEMA_OBJECT_TYPES,
    type SchemaValueSearchTarget,
} from './menuSql';

const SELECTABLE_OBJECT_TYPES = SELECTABLE_SCHEMA_OBJECT_TYPES;

const TABLE_ONLY_OBJECT_TYPES: ReadonlySet<string> = new Set(['TABLE']);

function isSelectableItem(item: SchemaItemData | undefined): boolean {
    return !!item && !!item.label && !!item.dbName && !!item.objType && SELECTABLE_OBJECT_TYPES.has(item.objType);
}

function isTableItem(item: SchemaItemData | undefined): boolean {
    return !!item && !!item.label && !!item.dbName && !!item.schema && !!item.objType && TABLE_ONLY_OBJECT_TYPES.has(item.objType);
}

function isRoutineItem(item: SchemaItemData | undefined): item is SchemaItemData {
    return !!item && !!item.label && !!item.dbName && (item.objType === 'PROCEDURE' || item.objType === 'FUNCTION');
}

/**
 * Open generated SQL in a new editor bound to the item's connection,
 * so it runs against the same database (mirrors copySelectAll).
 */
async function openSqlForItem(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    sql: string,
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
    if (item.connectionName) {
        deps.connectionManager.setDocumentConnection(doc.uri.toString(), item.connectionName);
        if (item.dbName) {
            await deps.connectionManager.setDocumentDatabase(doc.uri.toString(), item.dbName);
        }
    }
    await vscode.window.showTextDocument(doc);
}

/** Runs a query whose rows the user wants to see (counts, duplicates, routine output) in SQL Results. */
async function showItemQuery(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    sql: string,
    title: string,
): Promise<void> {
    await openAndRunSql(deps.connectionManager, { connectionName: item.connectionName, database: item.dbName }, sql, title);
}

async function executeItemSql(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    sql: string,
    progressTitle: string,
): Promise<void> {
    await executeWithProgress(progressTitle, async () => {
        await runQuery(deps.context, sql, true, item.connectionName, deps.connectionManager);
    });
}

function columnCacheKeyFor(
    databaseKind: DatabaseKind | undefined,
    database: string,
    schema: string | undefined,
    table: string,
): string {
    if (databaseKind !== 'netezza') {
        return buildColumnCacheKey(database, schema, table);
    }
    const catalogPart = (value: string): string =>
        isNetezzaQuotedIdentifier(value) ? unquoteNetezzaIdentifier(value) : value;
    const databaseValue = isNetezzaExactCachePart(database)
        ? decodeNetezzaCacheDatabasePart(database)
        : catalogPart(database);
    return buildColumnCacheKey(
        buildNetezzaCacheDatabasePart(databaseValue),
        schema === undefined ? undefined : catalogPart(schema),
        catalogPart(table),
        { preserveCase: true },
    );
}

/**
 * Register data-exploration commands
 */
export function registerDataCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { connectionManager, metadataCache } = deps;

    return [
        vscode.commands.registerCommand('netezza.countRows', async (item: SchemaItemData) => {
            if (!isSelectableItem(item)) {
                vscode.window.showErrorMessage('Select a table or view to count rows.');
                return;
            }
            await showItemQuery(deps, item, countRowsSql(getFullName(item, connectionManager)), `Row count of ${item.label}`);
        }),

        vscode.commands.registerCommand('netezza.findDuplicateRows', async (item: SchemaItemData) => {
            if (!isSelectableItem(item)) {
                vscode.window.showErrorMessage('Select a table or view to find duplicate rows.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            const columnsInput = await vscode.window.showInputBox({
                prompt: 'Enter key column names (comma separated)',
                placeHolder: 'e.g. account_id, order_no',
                validateInput: value => (value && value.trim().length > 0 ? null : 'Enter at least one column name.'),
            });
            if (!columnsInput) {
                return;
            }
            const quotedColumns = quoteIdentifierListForKind(columnsInput, databaseKind);
            if (!quotedColumns) {
                vscode.window.showErrorMessage('Enter at least one column name.');
                return;
            }
            await showItemQuery(
                deps,
                item,
                duplicateRowsSql(getFullName(item, connectionManager), quotedColumns),
                `Duplicate rows in ${item.label}`,
            );
        }),

        vscode.commands.registerCommand('netezza.createTableFromTable', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Select a table to create a new table from.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            const targetName = await vscode.window.showInputBox({
                prompt: 'Enter the new table name',
                placeHolder: 'e.g. NEW_TABLE',
                validateInput: value => {
                    if (!value || value.trim().length === 0) return 'Table name cannot be empty.';
                    if (!isValidIdentifier(value.trim())) return 'Invalid table name.';
                    return null;
                },
            });
            if (!targetName) {
                return;
            }
            const whereClause = await vscode.window.showInputBox({
                prompt: 'Optional WHERE filter for the copied rows (leave empty to copy all rows)',
                placeHolder: "e.g. status = 'active'",
            });
            if (whereClause === undefined) {
                return;
            }
            const target = formatQualifiedObjectName(item.dbName, item.schema, targetName.trim(), databaseKind);
            const sql = createTableFromSql(
                databaseKind,
                target,
                getFullName(item, connectionManager),
                whereClause,
            );
            await openSqlForItem(deps, item, `-- Review before running: creates ${target} from ${getFullName(item, connectionManager)}.\n${sql}\n`);
        }),

        vscode.commands.registerCommand('netezza.callRoutine', async (item: SchemaItemData) => {
            if (!isRoutineItem(item)) {
                vscode.window.showErrorMessage('Select a procedure or function to call.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            if (databaseKind && !deps.connectionManager.supportsCapability('supportsCallRoutine', undefined, item.connectionName)) {
                vscode.window.showErrorMessage('Calling routines is not supported for the active database dialect.');
                return;
            }
            const routineKind = item.objType as 'PROCEDURE' | 'FUNCTION';
            const argumentsSql = await vscode.window.showInputBox({
                prompt: 'Enter argument expressions in order (leave empty for no arguments)',
                placeHolder: "e.g. 42, 'active'",
            });
            if (argumentsSql === undefined) {
                return;
            }
            let sql: string;
            try {
                sql = callRoutineSql(databaseKind, routineKind, getFullName(item, connectionManager), argumentsSql);
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
                return;
            }
            if (routineKind === 'PROCEDURE') {
                const confirmation = await vscode.window.showWarningMessage(
                    `Run ${routineKind.toLowerCase()} "${getFullName(item, connectionManager)}"?\n\n${sql}`,
                    { modal: true },
                    'Yes, run',
                    'Cancel',
                );
                if (confirmation !== 'Yes, run') {
                    return;
                }
            }
            await showItemQuery(deps, item, sql, `Call ${item.label}`);
        }),

        vscode.commands.registerCommand('netezza.setTableStorage', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Select a table to change storage options.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            if (databaseKind !== 'postgresql') {
                vscode.window.showErrorMessage('Storage options are only available for PostgreSQL.');
                return;
            }
            const operation = await vscode.window.showQuickPick(
                [
                    { label: 'Set fillfactor', description: 'Table fillfactor, 10-100', action: 'setFillfactor' },
                    { label: 'Reset fillfactor', description: 'Remove the fillfactor setting', action: 'resetFillfactor' },
                    { label: 'Move to tablespace...', description: 'Rewrite the table into another tablespace', action: 'setTablespace' },
                ] as Array<{ label: string; description: string; action: 'setFillfactor' | 'resetFillfactor' | 'setTablespace' }>,
                { placeHolder: `Storage options for ${item.label}` },
            );
            if (!operation) {
                return;
            }
            const qualifiedName = getFullName(item, connectionManager);
            try {
                if (operation.action === 'resetFillfactor') {
                    await executeItemSql(deps, item, postgresTableStorageSql(qualifiedName, { operation: 'resetFillfactor' }), `Resetting fillfactor on ${item.label}...`);
                    return;
                }
                if (operation.action === 'setFillfactor') {
                    const valueInput = await vscode.window.showInputBox({
                        prompt: 'Enter fillfactor (10-100)',
                        placeHolder: 'e.g. 80',
                        validateInput: value => {
                            const parsed = Number(value.trim());
                            return Number.isInteger(parsed) && parsed >= 10 && parsed <= 100 ? null : 'Fillfactor must be a whole number from 10 to 100.';
                        },
                    });
                    if (!valueInput) {
                        return;
                    }
                    await executeItemSql(
                        deps,
                        item,
                        postgresTableStorageSql(qualifiedName, { operation: 'setFillfactor', value: Number(valueInput.trim()) }),
                        `Setting fillfactor on ${item.label}...`,
                    );
                    return;
                }
                const tablespace = await vscode.window.showInputBox({
                    prompt: 'Enter the target tablespace',
                    placeHolder: 'e.g. fastspace',
                    validateInput: value => (value && value.trim().length > 0 ? null : 'Tablespace name cannot be empty.'),
                });
                if (!tablespace) {
                    return;
                }
                await executeItemSql(
                    deps,
                    item,
                    postgresTableStorageSql(qualifiedName, { operation: 'setTablespace', name: tablespace }),
                    `Moving ${item.label} to tablespace...`,
                );
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            }
        }),

        vscode.commands.registerCommand('netezza.searchSchemaValues', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Select a table to search values in its schema.');
                return;
            }
            const connectionName = connectionManager.resolveConnectionName(undefined, item.connectionName);
            if (!connectionName) {
                vscode.window.showErrorMessage('No database connection. Please connect first.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
            if (!supportsSchemaValueSearch(databaseKind)) {
                vscode.window.showErrorMessage('Value search is supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB.');
                return;
            }
            const value = await vscode.window.showInputBox({
                prompt: 'Enter text or a number to search for across tables in this schema',
                placeHolder: "O'Neil or 42",
                validateInput: input => {
                    if (!input || !input.trim()) return 'Enter text or a number to search for.';
                    if (input.length > 8000) return 'Search text must be 8,000 characters or fewer.';
                    return null;
                },
            });
            if (!value) {
                return;
            }
            const schema = item.schema!;
            const dbName = item.dbName!;
            const tables = getTablesForScope(metadataCache, connectionName, dbName, schema) ?? [];
            if (!tables.length) {
                vscode.window.showWarningMessage(`No loaded tables found in schema ${schema}. Expand the schema in the tree first.`);
                return;
            }
            const targets: SchemaValueSearchTarget[] = [];
            let skippedTables = 0;
            for (const table of tables) {
                const tableName = table.OBJNAME || table.TABLENAME;
                if (!tableName || typeof tableName !== 'string') {
                    continue;
                }
                const key = columnCacheKeyFor(databaseKind, dbName, schema, tableName);
                const columns: ColumnMetadata[] | undefined = metadataCache.getColumns(connectionName, key);
                if (!columns) {
                    skippedTables++;
                    continue;
                }
                const qualifiedTableName = formatQualifiedObjectName(dbName, schema, tableName, databaseKind);
                for (const column of columns) {
                    const columnName = column.ATTNAME;
                    if (!columnName) {
                        continue;
                    }
                    targets.push({
                        location: databaseKind === 'netezza'
                            ? `${dbName}.${schema}.${tableName}.${columnName}`
                            : `${schema}.${tableName}.${columnName}`,
                        qualifiedTableName,
                        quotedColumnName: formatIdentifierForSql(columnName, databaseKind),
                        dataType: column.FORMAT_TYPE || '',
                    });
                }
            }
            let sql: string;
            try {
                sql = schemaValueSearchSql(databaseKind, value, targets);
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
                return;
            }
            await openSqlForItem(deps, item, `-- Review before running: searches ${targets.length} columns in schema ${schema}.\n${sql}\n`);
            if (skippedTables > 0) {
                vscode.window.showWarningMessage(
                    `${skippedTables} table(s) were skipped because their columns are not loaded. Expand them in the schema tree and retry for full coverage.`,
                );
            }
        }),

        vscode.commands.registerCommand('netezza.createIndex', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Select a table to create an index on.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            if (databaseKind !== 'oracle' && databaseKind !== 'duckdb' && databaseKind !== 'sqlite') {
                vscode.window.showErrorMessage('This quick index action is available for Oracle, DuckDB, and SQLite. Other dialects use their dedicated Index Designer.');
                return;
            }
            const columnsInput = await vscode.window.showInputBox({
                prompt: 'Enter index column names (comma separated)',
                placeHolder: 'e.g. created_at, user_id',
                validateInput: value => (value && value.trim().length > 0 ? null : 'Enter at least one column name.'),
            });
            if (!columnsInput) {
                return;
            }
            const quotedColumns = quoteIdentifierListForKind(columnsInput, databaseKind);
            if (!quotedColumns) {
                vscode.window.showErrorMessage('Enter at least one column name.');
                return;
            }
            const isUnique = await vscode.window.showQuickPick(
                [{ label: 'No', value: false }, { label: 'Yes', value: true }],
                { placeHolder: 'Create unique index?' },
            );
            if (isUnique === undefined) {
                return;
            }
            const indexNameInput = await vscode.window.showInputBox({
                prompt: 'Enter index name (leave empty to let the database choose)',
                placeHolder: `e.g. IDX_${item.label}`,
            });
            if (indexNameInput === undefined) {
                return;
            }
            const indexName = indexNameInput.trim()
                ? formatQualifiedObjectName(undefined, item.schema, indexNameInput.trim(), databaseKind)
                : formatQualifiedObjectName(undefined, item.schema, `IDX_${getItemObjectName(item)}`, databaseKind);
            let sql: string;
            try {
                sql = createIndexSql(databaseKind, indexName, getFullName(item, connectionManager), quotedColumns, { unique: isUnique.value });
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
                return;
            }
            const confirmation = await vscode.window.showInformationMessage(
                `Create index on table "${getFullName(item, connectionManager)}"?\n\n${sql}`,
                { modal: true },
                'Yes, create',
                'Cancel',
            );
            if (confirmation !== 'Yes, create') {
                return;
            }
            await executeItemSql(deps, item, sql, `Creating index on ${item.label}...`);
        }),

        vscode.commands.registerCommand('netezza.alterColumnQuick', async (item: SchemaItemData) => {
            if (!isTableItem(item)) {
                vscode.window.showErrorMessage('Select a table to alter a column.');
                return;
            }
            const databaseKind = connectionManager.getConnectionDatabaseKind?.(item.connectionName);
            if (databaseKind !== 'postgresql' && databaseKind !== 'db2' && databaseKind !== 'duckdb') {
                vscode.window.showErrorMessage('Quick column changes are available for PostgreSQL, Db2, and DuckDB.');
                return;
            }
            const operation = await vscode.window.showQuickPick(
                [
                    { label: 'ADD COLUMN', description: 'Add a column with type, nullability and default', action: 'add' },
                    { label: 'DROP COLUMN', description: 'Drop an existing column', action: 'drop' },
                    { label: 'RENAME COLUMN', description: 'Rename an existing column', action: 'rename' },
                    { label: 'CHANGE COLUMN TYPE', description: 'Change the SQL type of a column', action: 'type' },
                    { label: 'SET NOT NULL', description: 'Require values for a column', action: 'setNotNull' },
                    { label: 'DROP NOT NULL', description: 'Allow NULL values for a column', action: 'dropNotNull' },
                    { label: 'SET DEFAULT', description: 'Set the default expression for new rows', action: 'setDefault' },
                    { label: 'DROP DEFAULT', description: 'Remove the default expression', action: 'dropDefault' },
                ] as Array<{ label: string; description: string; action: string }>,
                { placeHolder: `Alter ${item.label}` },
            );
            if (!operation) {
                return;
            }
            const qualifiedName = getFullName(item, connectionManager);
            if (operation.action === 'add') {
                const columnName = await vscode.window.showInputBox({
                    prompt: 'Enter the new column name',
                    validateInput: value => (value && isValidIdentifier(value.trim()) ? null : 'Enter a valid column name.'),
                });
                if (!columnName) {
                    return;
                }
                const dataType = await vscode.window.showInputBox({
                    prompt: 'Enter the SQL data type',
                    placeHolder: 'VARCHAR(255)',
                    validateInput: value => (value && isSafeSqlDataType(value) ? null : 'Enter a SQL type made of type names and optional numeric parameters.'),
                });
                if (!dataType) {
                    return;
                }
                const nullability = await vscode.window.showQuickPick(['NULL', 'NOT NULL'], { placeHolder: 'Nullability' });
                if (!nullability) {
                    return;
                }
                const defaultValue = await vscode.window.showInputBox({
                    prompt: 'Default expression (optional, leave empty for no default)',
                    placeHolder: '0 or CURRENT_TIMESTAMP',
                });
                if (defaultValue === undefined) {
                    return;
                }
                const defaultExpression = defaultValue.trim();
                if (defaultExpression.includes(';')) {
                    vscode.window.showErrorMessage('Enter a single SQL default expression without a statement terminator.');
                    return;
                }
                const columnDefinition = `${formatIdentifierForSql(columnName.trim(), databaseKind)} ${dataType.trim()}${nullability === 'NOT NULL' ? ' NOT NULL' : ''}${defaultExpression ? ` DEFAULT ${defaultExpression}` : ''}`;
                const sql = `ALTER TABLE ${qualifiedName} ADD COLUMN ${columnDefinition};`;
                await openSqlForItem(deps, item, `-- Review before running: adds ${columnName.trim()} to ${qualifiedName}.\n${sql}\n`);
                return;
            }
            const columnName = await vscode.window.showInputBox({
                prompt: operation.action === 'rename' ? 'Enter the existing column name' : 'Enter the column name',
                validateInput: value => (value && value.trim().length > 0 ? null : 'Enter a column name.'),
            });
            if (!columnName) {
                return;
            }
            const quotedColumn = formatIdentifierForSql(columnName.trim(), databaseKind);
            if (operation.action === 'drop') {
                const sql = `ALTER TABLE ${qualifiedName} DROP COLUMN ${quotedColumn};`;
                const confirmation = await vscode.window.showWarningMessage(
                    `Drop column ${columnName.trim()} from "${qualifiedName}"?\n\n${sql}\n\nThis can remove data and may affect indexes or constraints.`,
                    { modal: true },
                    'Yes, drop',
                    'Cancel',
                );
                if (confirmation !== 'Yes, drop') {
                    return;
                }
                await executeItemSql(deps, item, sql, `Dropping column ${columnName.trim()}...`);
                return;
            }
            if (operation.action === 'rename') {
                const newName = await vscode.window.showInputBox({
                    prompt: 'Enter the new column name',
                    validateInput: value => (value && isValidIdentifier(value.trim()) ? null : 'Enter a valid column name.'),
                });
                if (!newName) {
                    return;
                }
                await executeItemSql(
                    deps,
                    item,
                    `ALTER TABLE ${qualifiedName} RENAME COLUMN ${quotedColumn} TO ${formatIdentifierForSql(newName.trim(), databaseKind)};`,
                    `Renaming column ${columnName.trim()}...`,
                );
                return;
            }
            try {
                if (operation.action === 'type') {
                    const dataType = await vscode.window.showInputBox({
                        prompt: 'Enter the new SQL type',
                        placeHolder: 'BIGINT',
                        validateInput: value => (value && isSafeSqlDataType(value) ? null : 'Enter a SQL type made of type names and optional numeric parameters.'),
                    });
                    if (!dataType) {
                        return;
                    }
                    let using: string | undefined;
                    if (databaseKind === 'postgresql' || databaseKind === 'duckdb') {
                        const conversion = await vscode.window.showInputBox({
                            prompt: 'Optional USING expression for converting existing values (leave empty for none)',
                            placeHolder: `${quotedColumn}::${dataType.trim()}`,
                        });
                        if (conversion === undefined) {
                            return;
                        }
                        using = conversion.trim() || undefined;
                    }
                    await executeItemSql(
                        deps,
                        item,
                        alterColumnSql(databaseKind, qualifiedName, quotedColumn, { operation: 'setType', dataType, using }),
                        `Changing type of ${columnName.trim()}...`,
                    );
                    return;
                }
                if (operation.action === 'setNotNull') {
                    await executeItemSql(deps, item, alterColumnSql(databaseKind, qualifiedName, quotedColumn, { operation: 'setNotNull' }), `Setting NOT NULL on ${columnName.trim()}...`);
                    return;
                }
                if (operation.action === 'dropNotNull') {
                    await executeItemSql(deps, item, alterColumnSql(databaseKind, qualifiedName, quotedColumn, { operation: 'dropNotNull' }), `Dropping NOT NULL on ${columnName.trim()}...`);
                    return;
                }
                if (operation.action === 'setDefault') {
                    const expression = await vscode.window.showInputBox({
                        prompt: 'Enter the SQL default expression for new rows',
                        placeHolder: '0 or CURRENT TIMESTAMP',
                    });
                    if (expression === undefined) {
                        return;
                    }
                    await executeItemSql(deps, item, alterColumnSql(databaseKind, qualifiedName, quotedColumn, { operation: 'setDefault', expression }), `Setting default on ${columnName.trim()}...`);
                    return;
                }
                await executeItemSql(deps, item, alterColumnSql(databaseKind, qualifiedName, quotedColumn, { operation: 'dropDefault' }), `Dropping default on ${columnName.trim()}...`);
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            }
        }),
    ];
}
