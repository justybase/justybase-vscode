/**
 * "Query File with SQL (DuckDB)" command: opens a SQL editor bound to a
 * File SQL connection for the selected xlsx/xlsb/csv/parquet/avro file.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { createRequire } from 'node:module';
import {
    buildSaveEditsSql,
    detectFileDataFormat,
    editableTableName,
    fileSheetViewName,
    normalizeFilePath,
    parseFileWorkspace,
    sanitizeViewName,
} from './fileSqlSetup';
import { listXlsxSheetNames } from './xlsxSheets';
import { listXlsbSheetNames } from './xlsbConversion';

const FILE_QUERY_COMMAND_ID = 'justybase.duckdb.queryFile';
const FILE_WORKSPACE_QUERY_COMMAND_ID = 'justybase.duckdb.queryFiles';
const ADD_FILES_TO_WORKSPACE_COMMAND_ID = 'justybase.duckdb.addFiles';
const OPEN_FILE_WORKSPACE_COMMAND_ID = 'justybase.duckdb.openWorkspace';
const SAVE_FILE_EDITS_COMMAND_ID = 'justybase.duckdb.saveFileEdits';

interface JustyBaseLiteApi {
    registerDatabaseDialect(dialect: unknown): unknown;
    openFileSqlSession(
        details: {
            name?: string;
            host: string;
            port?: number;
            database: string;
            user: string;
            password?: string;
            dbType?: string;
            options?: Record<string, string | number | boolean>;
        },
        options?: { content?: string; connectionName?: string },
    ): Promise<void>;
    openFileSqlWorkspaceSession(
        filePaths: readonly string[],
        options?: { content?: string; connectionName?: string },
    ): Promise<void>;
    listSavedConnections(): Promise<ReadonlyArray<{
        name: string;
        details: {
            name?: string;
            host: string;
            database: string;
            user: string;
            dbType?: string;
            options?: Record<string, string | number | boolean>;
        };
    }>>;
    getActiveConnectionDetails(): Promise<
        | {
            name: string;
            details: {
                name?: string;
                host: string;
                database: string;
                user: string;
                dbType?: string;
                options?: Record<string, string | number | boolean>;
            };
            documentUri?: string;
            documentBound: boolean;
        }
        | undefined
    >;
    executeActiveConnectionSql(sql: string, documentUri?: string): Promise<void>;
    /** Optional (core API >= companion pair): execute SQL and return all rows. */
    executeActiveConnectionSqlQuery?(sql: string, documentUri?: string): Promise<{
        columns: string[];
        rows: unknown[][];
    }>;
}

interface FileSqlSchemaItemResource {
    readonly connectionName?: string;
}

type AddFilesCommandResource = vscode.Uri | readonly vscode.Uri[] | FileSqlSchemaItemResource;

export function registerFileQueryCommand(api: JustyBaseLiteApi, subscriptions: vscode.Disposable[]): void {
    subscriptions.push(vscode.commands.registerCommand(FILE_QUERY_COMMAND_ID, async (resource?: vscode.Uri) => {
        const fileUri = resource ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri || !fileUri.scheme) {
            vscode.window.showErrorMessage('Query File with SQL requires a selected data file.');
            return;
        }

        const filePath = fileUri.fsPath;
        const basename = path.basename(filePath);
        const parentDir = path.dirname(filePath);
        const viewName = sanitizeViewName(filePath);
        const format = detectFileDataFormat(filePath);
        const connectionName = `File SQL: ${basename} — ${parentDir}`;

        const isExcel = format === 'xlsx' || format === 'xlsb';
        let firstSheet: string | undefined;
        if (format === 'xlsb') {
            try {
                firstSheet = (await listXlsbSheetNames(filePath))[0];
            } catch {
                firstSheet = undefined;
            }
        }

        try {
            await api.openFileSqlSession(
                {
                    name: connectionName,
                    host: 'local',
                    database: filePath,
                    user: 'file',
                    dbType: 'file',
                    options: {
                        editable: true,
                        // xlsx keeps the default per-sheet view layout; xlsb pins the
                        // editable sheet so "Save File Edits" rewrites it in place.
                        ...(format === 'xlsb' && firstSheet ? { sheet: firstSheet } : {}),
                    },
                },
                {
                    connectionName,
                    content: [
                        `-- ${basename} — File SQL (DuckDB)`,
                        format === 'xlsb'
                            ? `-- ${viewName} reads the first sheet; "Save File Edits" rewrites it in place.`
                            : isExcel
                                ? `-- Excel sheets appear as ${viewName}__<sheet>; ${viewName} reads the first sheet.`
                                : '-- Query the file like a table.',
                        `-- INSERT/UPDATE/DELETE work on ${editableTableName(filePath)} (editable copy).`,
                        '-- After editing run "JustyBase: Save File Edits" to write changes back.',
                        '',
                        `SELECT * FROM "${viewName}" LIMIT 100;`,
                        '',
                    ].join('\n'),
                },
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to open File SQL session: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }));

    subscriptions.push(vscode.commands.registerCommand(
        FILE_WORKSPACE_QUERY_COMMAND_ID,
        async (resource?: vscode.Uri | readonly vscode.Uri[]) => {
            const selectedUris = Array.isArray(resource)
                ? resource
                : resource
                    ? [resource]
                    : undefined;
            const filePaths = selectedUris?.map(uri => uri.fsPath).filter(isSupportedDataFile);
            const paths = filePaths && filePaths.length > 1
                ? filePaths
                : await chooseWorkspaceFiles(filePaths?.[0]);
            if (!paths || paths.length === 0) {
                return;
            }

            try {
                await openWorkspace(api, paths);
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to open File SQL workspace: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        },
    ));

    subscriptions.push(vscode.commands.registerCommand(
        ADD_FILES_TO_WORKSPACE_COMMAND_ID,
        async (resource?: AddFilesCommandResource) => {
            try {
                await addFilesToActiveWorkspace(api, resource);
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to add files to File SQL workspace: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        },
    ));

    subscriptions.push(vscode.commands.registerCommand(OPEN_FILE_WORKSPACE_COMMAND_ID, async () => {
        try {
            const connections = await api.listSavedConnections();
            const workspaces = connections
                .map(connection => {
                    const files = parseFileWorkspace(connection.details.options?.fileWorkspace);
                    return files ? { ...connection, files } : undefined;
                })
                .filter((connection): connection is NonNullable<typeof connection> => Boolean(connection));

            if (workspaces.length === 0) {
                vscode.window.showInformationMessage('No saved multi-file SQL workspaces were found.');
                return;
            }

            const selected = await vscode.window.showQuickPick(
                workspaces.map(workspace => ({
                    label: workspace.name,
                    description: `${workspace.files.length} file(s)`,
                    detail: workspace.files.join(', '),
                    workspace,
                })),
                { placeHolder: 'Open saved File SQL workspace' },
            );
            if (!selected) {
                return;
            }

            await api.openFileSqlWorkspaceSession(selected.workspace.files, {
                connectionName: selected.workspace.name,
                content: await buildWorkspaceSqlContent(selected.workspace.files, selected.workspace.name),
            });
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to open File SQL workspace: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }));

    subscriptions.push(vscode.commands.registerCommand(SAVE_FILE_EDITS_COMMAND_ID, async () => {
        try {
            const active = await api.getActiveConnectionDetails();
            if (!active) {
                vscode.window.showInformationMessage('Save File Edits requires an active File SQL connection.');
                return;
            }
            if (!active.documentBound || !active.documentUri) {
                vscode.window.showInformationMessage('Save File Edits requires the active File SQL editor.');
                return;
            }
            const details = active.details;
            if ((details.dbType ?? '') !== 'file') {
                vscode.window.showInformationMessage(
                    'Save File Edits only works for File SQL connections (xlsx/xlsb/csv/parquet/avro).',
                );
                return;
            }

            if (parseFileWorkspace(details.options?.fileWorkspace)) {
                vscode.window.showInformationMessage(
                    'Save File Edits is not available for multi-file SQL workspaces. Export the query result instead.',
                );
                return;
            }

            const filePath = details.database;
            const format = detectFileDataFormat(filePath);
            if (!format) {
                vscode.window.showErrorMessage(`Unsupported data file '${filePath}'.`);
                return;
            }

            if (format === 'xlsb') {
                await saveXlsbEdits(api, filePath, typeof details.options?.sheet === 'string' ? details.options.sheet : undefined, active.documentUri);
                return;
            }

            const built = buildSaveEditsSql(filePath, format);
            await api.executeActiveConnectionSql(built.sql, active.documentUri);

            if (built.writesToNewFile) {
                vscode.window.showInformationMessage(
                    `Avro cannot be written back — edited data saved to ${built.targetPath}.`,
                );
            } else {
                vscode.window.showInformationMessage(`Saved edits to ${built.targetPath}.`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const hint = /does not exist|no such table/i.test(message)
                ? ' Enable the "Editable copy" option on the File SQL connection first.'
                : '';
            vscode.window.showErrorMessage(`Save File Edits failed: ${message}${hint}`);
        }
    }));
}

function isSupportedDataFile(filePath: string): boolean {
    return detectFileDataFormat(filePath) !== undefined;
}

/**
 * Write the editable copy back into the original .xlsb workbook in place.
 * DuckDB cannot write XLSB (COPY TO only knows CSV/Parquet/XLSX), so the
 * command fetches the editable table rows from DuckDB and rewrites the target
 * sheet with @justybase/spreadsheet-tasks XlsbUpdater (the rest of the
 * workbook — other sheets, styles, pivots — is preserved byte-for-byte).
 */
async function saveXlsbEdits(
    api: JustyBaseLiteApi,
    filePath: string,
    sheetName: string | undefined,
    documentUri?: string,
): Promise<void> {
    if (typeof api.executeActiveConnectionSqlQuery !== 'function') {
        throw new Error('The installed base extension does not support XLSB write-back. Update JustyBase SQL Editor.');
    }

    const tableName = editableTableName(filePath);
    const { columns, rows } = await api.executeActiveConnectionSqlQuery(
        `SELECT * FROM "${tableName}"`,
        documentUri,
    );

    const { XlsbUpdater } = requireSpreadsheetTasks();
    const updater = new XlsbUpdater(filePath);
    const availableSheets = updater.getSheetNames();
    const targetSheet = sheetName && availableSheets.includes(sheetName)
        ? sheetName
        : availableSheets[0];
    if (!targetSheet) {
        throw new Error(`XLSB workbook '${filePath}' contains no sheets.`);
    }
    if (sheetName && targetSheet !== sheetName) {
        vscode.window.showWarningMessage(
            `Sheet "${sheetName}" no longer exists in '${path.basename(filePath)}'; ` +
            `saving edits to sheet "${targetSheet}" instead.`,
        );
    }

    updater.replaceSheetData(
        targetSheet,
        rows.map(row => row.map(normalizeCellValue)),
        { headers: columns },
    );
    updater.save();

    vscode.window.showInformationMessage(`Saved edits to ${filePath} (sheet "${targetSheet}").`);
}

/** Map DuckDB cell values to values XlsbUpdater accepts (bigint → number). */
function normalizeCellValue(value: unknown): string | number | boolean | Date | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (value instanceof Date || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    return String(value);
}

function requireSpreadsheetTasks(): { XlsbUpdater: new (filePath: string) => XlsbUpdaterLike } {
    const { XlsbUpdater } = createRequire(__filename)('@justybase/spreadsheet-tasks') as {
        XlsbUpdater: new (filePath: string) => XlsbUpdaterLike;
    };
    return { XlsbUpdater };
}

interface XlsbUpdaterLike {
    getSheetNames(): string[];
    replaceSheetData(
        sheetName: string,
        rows: Array<Array<string | number | boolean | Date | null>>,
        options?: { headers?: string[]; styleFallback?: 'inherit' | 'general' },
    ): void;
    save(outputPath?: string): void;
}

async function chooseWorkspaceFiles(initialPath?: string): Promise<string[] | undefined> {
    const result = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFolders: false,
        openLabel: 'Open File SQL Workspace',
        filters: {
            'Data files': ['xlsx', 'xlsb', 'csv', 'tsv', 'parquet', 'avro'],
        },
    });
    const paths = result?.map(uri => uri.fsPath).filter(isSupportedDataFile) ?? [];
    if (initialPath && isSupportedDataFile(initialPath)) {
        paths.unshift(initialPath);
    }
    const uniquePaths = Array.from(new Set(paths));
    return uniquePaths.length > 0 ? uniquePaths : undefined;
}

async function openWorkspace(api: JustyBaseLiteApi, filePaths: readonly string[]): Promise<void> {
    const normalizedFiles = Array.from(new Set(filePaths.map(normalizeFilePath)));
    const existingNames = new Set((await api.listSavedConnections()).map(connection => connection.name));
    const firstBaseName = path.basename(normalizedFiles[0]);
    const baseName = `File SQL Workspace: ${firstBaseName}`;
    let connectionName = baseName;
    let suffix = 2;
    while (existingNames.has(connectionName)) {
        connectionName = `${baseName} (${suffix})`;
        suffix += 1;
    }

    await api.openFileSqlWorkspaceSession(normalizedFiles, {
        connectionName,
        content: await buildWorkspaceSqlContent(normalizedFiles, connectionName),
    });
}

async function buildWorkspaceSqlContent(filePaths: readonly string[], connectionName: string): Promise<string> {
    const lines = [
        `-- ${connectionName} — File SQL (DuckDB)`,
        '-- Read-only workspace. Each source is a view named by its full path.',
        '-- For XLSX/XLSB files, every discovered sheet is available as "<path>#sheet=<sheet>".',
        '-- Use normal SQL aliases in your query when convenient.',
        '-- To add more files, run "Add Files to Active File SQL Workspace (DuckDB)".',
        '',
        '-- Available sources:',
    ];

    for (const filePath of filePaths) {
        const normalizedPath = normalizeFilePath(filePath);
        lines.push(`-- ${quoteIdentifier(normalizedPath)}`);
        const format = detectFileDataFormat(normalizedPath);
        if (format === 'xlsx') {
            for (const sheet of discoverSheets(normalizedPath)) {
                lines.push(`-- ${quoteIdentifier(fileSheetViewName(normalizedPath, sheet))}`);
            }
        } else if (format === 'xlsb') {
            for (const sheet of await discoverXlsbSheets(normalizedPath)) {
                lines.push(`-- ${quoteIdentifier(fileSheetViewName(normalizedPath, sheet))}`);
            }
        }
    }

    lines.push(
        '',
        `SELECT * FROM ${quoteIdentifier(normalizeFilePath(filePaths[0]))} LIMIT 100;`,
        '',
    );
    return lines.join('\n');
}

function discoverSheets(filePath: string): string[] {
    try {
        return listXlsxSheetNames(filePath);
    } catch {
        return [];
    }
}

async function discoverXlsbSheets(filePath: string): Promise<string[]> {
    try {
        return await listXlsbSheetNames(filePath);
    } catch {
        return [];
    }
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

async function addFilesToActiveWorkspace(
    api: JustyBaseLiteApi,
    resource?: AddFilesCommandResource,
): Promise<void> {
    const schemaConnectionName = getSchemaConnectionName(resource);
    let connectionName: string;
    let workspaceOptions: {
        options?: Record<string, string | number | boolean>;
    };

    if (schemaConnectionName) {
        const savedConnection = (await api.listSavedConnections()).find(
            connection => connection.name === schemaConnectionName,
        );
        if (!savedConnection) {
            vscode.window.showInformationMessage(
                `The File SQL connection '${schemaConnectionName}' is no longer available.`,
            );
            return;
        }
        connectionName = savedConnection.name;
        workspaceOptions = savedConnection.details;
    } else {
        const active = await api.getActiveConnectionDetails();
        if (!active || !active.documentBound || !active.documentUri) {
            vscode.window.showInformationMessage(
                'Open a SQL editor bound to a multi-file workspace before adding files.',
            );
            return;
        }
        connectionName = active.name;
        workspaceOptions = active.details;
    }

    const currentFiles = parseFileWorkspace(workspaceOptions.options?.fileWorkspace);
    if (!currentFiles) {
        vscode.window.showInformationMessage(
            `The File SQL connection '${connectionName}' is not a multi-file workspace.`,
        );
        return;
    }

    const selectedPaths = getSelectedFilePaths(resource);
    const additionalFiles = selectedPaths && selectedPaths.length > 0
        ? selectedPaths
        : await chooseWorkspaceFiles();
    if (!additionalFiles || additionalFiles.length === 0) {
        return;
    }

    const mergedFiles = Array.from(new Set([...currentFiles, ...additionalFiles.map(normalizeFilePath)]));
    if (mergedFiles.length === currentFiles.length) {
        vscode.window.showInformationMessage('All selected files are already in the active workspace.');
        return;
    }

    await api.openFileSqlWorkspaceSession(mergedFiles, {
        connectionName,
        content: await buildWorkspaceSqlContent(mergedFiles, connectionName),
    });
    vscode.window.showInformationMessage(
        `Added ${mergedFiles.length - currentFiles.length} file(s) to '${connectionName}'. A new SQL editor was opened.`,
    );
}

function getSelectedFilePaths(resource?: AddFilesCommandResource): string[] | undefined {
    const selectedUris = Array.isArray(resource)
        ? resource
        : resource && isUriResource(resource)
            ? [resource]
            : undefined;
    return selectedUris?.map(uri => uri.fsPath).filter(isSupportedDataFile);
}

function getSchemaConnectionName(resource?: AddFilesCommandResource): string | undefined {
    if (!resource || isUriListResource(resource) || isUriResource(resource)) {
        return undefined;
    }
    return resource.connectionName?.trim() || undefined;
}

function isUriListResource(resource: AddFilesCommandResource): resource is readonly vscode.Uri[] {
    return Array.isArray(resource);
}

function isUriResource(resource: AddFilesCommandResource): resource is vscode.Uri {
    return 'fsPath' in resource && typeof resource.fsPath === 'string';
}
