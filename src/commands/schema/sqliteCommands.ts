import * as vscode from 'vscode';
import { queryResultToRows, runQueryRaw } from '../../core/queryRunner';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../utils/identifierUtils';
import type { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getItemObjectName } from './helpers';

interface SqliteSelection {
    connectionName: string;
    catalog: string;
    objectName?: string;
}

interface SqliteIndexRow extends Record<string, unknown> {
    NAME: string;
    IS_UNIQUE?: number;
    ORIGIN?: string;
    IS_PARTIAL?: number;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function formatSqliteCatalogIdentifier(catalog: string): string {
    return formatIdentifierForSql(catalog, 'sqlite');
}

function normalizeSqliteSelectionCatalog(item: SchemaItemData): string | undefined {
    return (item.dbName || item.label || '').trim() || undefined;
}

function normalizeColumnList(input: string): string[] {
    return input
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0);
}

async function resolveSqliteSelection(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData | undefined,
    requireObjectName: boolean
): Promise<SqliteSelection | undefined> {
    if (!item) {
        vscode.window.showErrorMessage('Invalid SQLite object selection.');
        return undefined;
    }

    const connectionName = deps.connectionManager.resolveConnectionName(undefined, item.connectionName);
    if (!connectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return undefined;
    }

    if (deps.connectionManager.getConnectionDatabaseKind(connectionName) !== 'sqlite') {
        vscode.window.showErrorMessage('This action is only available for SQLite connections.');
        return undefined;
    }

    const catalog = normalizeSqliteSelectionCatalog(item);
    if (!catalog) {
        vscode.window.showErrorMessage('Unable to resolve the SQLite database/catalog for this item.');
        return undefined;
    }

    const objectName = requireObjectName ? getItemObjectName(item).trim() : undefined;
    if (requireObjectName && !objectName) {
        vscode.window.showErrorMessage('Unable to resolve the SQLite object name for this item.');
        return undefined;
    }

    return { connectionName, catalog, objectName };
}

async function executeSqliteSql(
    deps: SchemaCommandsDependencies,
    selection: SqliteSelection,
    title: string,
    sql: string
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- ${title}\n${sql}`
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    deps.connectionManager.setDocumentConnection(doc.uri.toString(), selection.connectionName);
    await deps.connectionManager.setDocumentDatabase(doc.uri.toString(), selection.catalog);
    await vscode.commands.executeCommand('netezza.runQuery');
}

async function querySqliteRows<T extends Record<string, unknown>>(
    deps: SchemaCommandsDependencies,
    selection: SqliteSelection,
    sql: string
): Promise<T[]> {
    const result = await runQueryRaw({
        context: deps.context,
        query: sql,
        silent: true,
        connectionManager: deps.connectionManager,
        connectionName: selection.connectionName,
        isUserQuery: false,
        maxRows: 1000
    });
    return queryResultToRows<T>(result);
}

function buildSQLiteTableQuery(
    catalog: string,
    tableName: string,
    body: string
): string {
    const catalogIdentifier = formatSqliteCatalogIdentifier(catalog);
    return body
        .split('${catalog}')
        .join(catalogIdentifier)
        .split('${table}')
        .join(escapeSqlLiteral(tableName));
}

async function executeTableAction(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    title: string,
    sqlFactory: (selection: SqliteSelection) => string
): Promise<void> {
    const selection = await resolveSqliteSelection(deps, item, true);
    if (!selection) {
        return;
    }

    try {
        await executeSqliteSql(deps, selection, title, sqlFactory(selection));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`SQLite action failed: ${message}`);
    }
}

async function executeDatabaseAction(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    title: string,
    sqlFactory: (selection: SqliteSelection) => Promise<string> | string
): Promise<void> {
    const selection = await resolveSqliteSelection(deps, item, false);
    if (!selection) {
        return;
    }

    try {
        await executeSqliteSql(deps, selection, title, await sqlFactory(selection));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`SQLite action failed: ${message}`);
    }
}

export function registerSqliteCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.sqlite.viewIndexes', async (item: SchemaItemData) => {
            await executeTableAction(deps, item, 'SQLite: View Indexes', selection => buildSQLiteTableQuery(
                selection.catalog,
                selection.objectName || '',
                `
                    SELECT
                        name AS NAME,
                        "unique" AS IS_UNIQUE,
                        origin AS ORIGIN,
                        partial AS IS_PARTIAL
                    FROM ${'${catalog}'}.pragma_index_list('${'${table}'}')
                    ORDER BY name;
                `
            ));
        }),
        vscode.commands.registerCommand('netezza.sqlite.addIndex', async (item: SchemaItemData) => {
            const selection = await resolveSqliteSelection(deps, item, true);
            if (!selection || !selection.objectName) {
                return;
            }

            const indexName = await vscode.window.showInputBox({
                prompt: 'Enter SQLite index name',
                value: `${selection.objectName}_idx`,
                validateInput: value => value.trim().length > 0 ? null : 'Index name cannot be empty.'
            });
            if (!indexName) {
                return;
            }

            const columnsInput = await vscode.window.showInputBox({
                prompt: 'Enter index columns (comma separated)',
                placeHolder: 'e.g. customer_id, created_at',
                validateInput: value => normalizeColumnList(value).length > 0 ? null : 'Provide at least one column.'
            });
            if (!columnsInput) {
                return;
            }

            const uniqueness = await vscode.window.showQuickPick(
                [
                    { label: 'Normal index', value: '' },
                    { label: 'Unique index', value: 'UNIQUE ' }
                ],
                { placeHolder: 'Select SQLite index type' }
            );
            if (!uniqueness) {
                return;
            }

            const columnList = normalizeColumnList(columnsInput)
                .map(column => formatIdentifierForSql(column, 'sqlite'))
                .join(', ');
            const indexPath = formatQualifiedObjectName(selection.catalog, undefined, indexName.trim(), 'sqlite');
            const tablePath = formatQualifiedObjectName(selection.catalog, undefined, selection.objectName, 'sqlite');

            await executeSqliteSql(
                deps,
                selection,
                'SQLite: Add Index',
                `CREATE ${uniqueness.value}INDEX ${indexPath} ON ${tablePath} (${columnList});`
            );
        }),
        vscode.commands.registerCommand('netezza.sqlite.dropIndex', async (item: SchemaItemData) => {
            const selection = await resolveSqliteSelection(deps, item, true);
            if (!selection || !selection.objectName) {
                return;
            }

            try {
                const rows = await querySqliteRows<SqliteIndexRow>(
                    deps,
                    selection,
                    buildSQLiteTableQuery(
                        selection.catalog,
                        selection.objectName,
                        `
                            SELECT
                                name AS NAME,
                                "unique" AS IS_UNIQUE,
                                origin AS ORIGIN,
                                partial AS IS_PARTIAL
                            FROM ${'${catalog}'}.pragma_index_list('${'${table}'}')
                            ORDER BY name;
                        `
                    )
                );

                if (rows.length === 0) {
                    vscode.window.showInformationMessage(`No indexes found for ${selection.catalog}.${selection.objectName}.`);
                    return;
                }

                const pickedIndex = await vscode.window.showQuickPick(
                    rows.map(row => ({
                        label: row.NAME,
                        description: row.IS_UNIQUE === 1 ? 'UNIQUE' : 'INDEX',
                        detail: [row.ORIGIN, row.IS_PARTIAL === 1 ? 'PARTIAL' : '']
                            .filter(Boolean)
                            .join(' • ')
                    })),
                    { placeHolder: 'Select SQLite index to drop' }
                );
                if (!pickedIndex) {
                    return;
                }

                const indexPath = formatQualifiedObjectName(selection.catalog, undefined, pickedIndex.label, 'sqlite');
                await executeSqliteSql(
                    deps,
                    selection,
                    'SQLite: Drop Index',
                    `DROP INDEX IF EXISTS ${indexPath};`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`SQLite action failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand('netezza.sqlite.viewForeignKeys', async (item: SchemaItemData) => {
            await executeTableAction(deps, item, 'SQLite: View Foreign Keys', selection => buildSQLiteTableQuery(
                selection.catalog,
                selection.objectName || '',
                `
                    SELECT
                        id AS FK_ID,
                        seq AS POSITION,
                        "table" AS REFERENCED_TABLE,
                        "from" AS COLUMN_NAME,
                        "to" AS REFERENCED_COLUMN,
                        on_update AS ON_UPDATE,
                        on_delete AS ON_DELETE,
                        match AS MATCH_TYPE
                    FROM ${'${catalog}'}.pragma_foreign_key_list('${'${table}'}')
                    ORDER BY id, seq;
                `
            ));
        }),
        vscode.commands.registerCommand('netezza.sqlite.viewTriggers', async (item: SchemaItemData) => {
            await executeTableAction(deps, item, 'SQLite: View Triggers', selection => {
                const catalogIdentifier = formatSqliteCatalogIdentifier(selection.catalog);
                return `
                    SELECT
                        name AS NAME,
                        sql AS SQL
                    FROM ${catalogIdentifier}.sqlite_master
                    WHERE type = 'trigger'
                      AND tbl_name = '${escapeSqlLiteral(selection.objectName || '')}'
                    ORDER BY name;
                `;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.reindexTable', async (item: SchemaItemData) => {
            await executeTableAction(deps, item, 'SQLite: Reindex Table', selection => {
                const tablePath = formatQualifiedObjectName(selection.catalog, undefined, selection.objectName || '', 'sqlite');
                return `REINDEX ${tablePath};`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.analyzeTable', async (item: SchemaItemData) => {
            await executeTableAction(deps, item, 'SQLite: Analyze Table', selection => {
                const tablePath = formatQualifiedObjectName(selection.catalog, undefined, selection.objectName || '', 'sqlite');
                return `ANALYZE ${tablePath};`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.vacuum', async (item: SchemaItemData) => {
            await executeDatabaseAction(deps, item, 'SQLite: VACUUM', async selection => {
                const catalogClause = selection.catalog === 'main' ? '' : ` ${formatIdentifierForSql(selection.catalog, 'sqlite')}`;
                return `VACUUM${catalogClause};`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.vacuumInto', async (item: SchemaItemData) => {
            const selection = await resolveSqliteSelection(deps, item, false);
            if (!selection) {
                return;
            }

            const targetUri = await vscode.window.showSaveDialog({
                filters: { 'SQLite Database': ['db', 'sqlite', 'sqlite3'] },
                saveLabel: 'Export SQLite database copy'
            });
            if (!targetUri) {
                return;
            }

            const catalogClause = selection.catalog === 'main'
                ? ''
                : ` ${formatIdentifierForSql(selection.catalog, 'sqlite')}`;
            try {
                await executeSqliteSql(
                    deps,
                    selection,
                    'SQLite: VACUUM INTO',
                    `VACUUM${catalogClause} INTO '${escapeSqlLiteral(targetUri.fsPath)}';`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`SQLite action failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand('netezza.sqlite.integrityCheck', async (item: SchemaItemData) => {
            await executeDatabaseAction(deps, item, 'SQLite: Integrity Check', selection => {
                const catalogIdentifier = formatIdentifierForSql(selection.catalog, 'sqlite');
                return `PRAGMA ${catalogIdentifier}.integrity_check;`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.foreignKeyCheck', async (item: SchemaItemData) => {
            await executeDatabaseAction(deps, item, 'SQLite: Foreign Key Check', selection => {
                const catalogIdentifier = formatIdentifierForSql(selection.catalog, 'sqlite');
                return `PRAGMA ${catalogIdentifier}.foreign_key_check;`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.walCheckpoint', async (item: SchemaItemData) => {
            await executeDatabaseAction(deps, item, 'SQLite: WAL Checkpoint', selection => {
                const catalogIdentifier = formatIdentifierForSql(selection.catalog, 'sqlite');
                return `PRAGMA ${catalogIdentifier}.wal_checkpoint(FULL);`;
            });
        }),
        vscode.commands.registerCommand('netezza.sqlite.databaseInfo', async (item: SchemaItemData) => {
            await executeDatabaseAction(deps, item, 'SQLite: Database Info', selection => {
                const catalogIdentifier = formatIdentifierForSql(selection.catalog, 'sqlite');
                return [
                    'PRAGMA database_list;',
                    `PRAGMA ${catalogIdentifier}.page_count;`,
                    `PRAGMA ${catalogIdentifier}.page_size;`,
                    `PRAGMA ${catalogIdentifier}.journal_mode;`
                ].join('\n');
            });
        })
    ];
}
