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
    fileTableViewName,
    fileTableViewNames,
    normalizeFilePath,
    parseFileWorkspace,
    sanitizeViewName,
} from './fileSqlSetup';
import { listXlsxSheetNames } from './xlsxSheets';
import { listXlsbSheetNames } from './xlsbConversion';
import { listAccessTableNames } from './accessConversion';
import { resolveFileSourceConnectionName } from '../../../src/services/fileConnectionProfileService';

const FILE_QUERY_COMMAND_ID = 'justybase.duckdb.queryFile';
const FILE_WORKSPACE_QUERY_COMMAND_ID = 'justybase.duckdb.queryFiles';
const ADD_FILES_TO_WORKSPACE_COMMAND_ID = 'justybase.duckdb.addFiles';
const OPEN_FILE_WORKSPACE_COMMAND_ID = 'justybase.duckdb.openWorkspace';
const SAVE_FILE_EDITS_COMMAND_ID = 'justybase.duckdb.saveFileEdits';
const EDIT_FILE_SOURCE_COMMAND_ID = 'justybase.duckdb.editFileSource';

export interface EditFileSourceRequest {
    filePath: string;
    connectionName?: string;
}

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
        options?: { content?: string; connectionName?: string; updateExisting?: boolean },
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
    subscriptions.push(vscode.commands.registerCommand(EDIT_FILE_SOURCE_COMMAND_ID, async (request?: EditFileSourceRequest) => {
        try {
            await openEditableFileSource(api, request);
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to open file source for editing: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }));

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
        const isAccess = format === 'access';
        let firstSheet: string | undefined;
        let tableNames: string[] = [];
        if (format === 'xlsb') {
            try {
                firstSheet = (await listXlsbSheetNames(filePath))[0];
            } catch {
                firstSheet = undefined;
            }
        } else if (isAccess) {
            try {
                tableNames = await listAccessTableNames(filePath);
            } catch {
                tableNames = [];
            }
        }

        const tableViewNames = isAccess
            ? fileTableViewNames(filePath, tableNames)
            : new Map<string, string>();
        const defaultViewName = isAccess
            ? tableViewNames.get(tableNames[0] ?? '') ?? viewName
            : viewName;

        try {
            await api.openFileSqlSession(
                {
                    name: connectionName,
                    host: 'local',
                    database: filePath,
                    user: 'file',
                    dbType: 'file',
                    options: {
                        // Access files are read-only in File SQL mode.
                        ...(isAccess ? {} : { editable: true }),
                        // xlsx keeps the default per-sheet view layout; xlsb pins the
                        // editable sheet so "Save File Edits" rewrites it in place.
                        ...(format === 'xlsb' && firstSheet ? { sheet: firstSheet } : {}),
                    },
                },
                {
                    connectionName,
                    content: [
                        `-- ${basename} — File SQL (DuckDB)`,
                        isAccess
                            ? `-- Access tables appear as ${viewName}__<table> (read-only; queries only).`
                            : format === 'xlsb'
                                ? `-- ${viewName} reads the first sheet; "Save File Edits" rewrites it in place.`
                                : isExcel
                                    ? `-- Excel sheets appear as ${viewName}__<sheet>; ${viewName} reads the first sheet.`
                                    : '-- Query the file like a table.',
                        ...(isAccess
                            ? tableNames.map(table => `-- Table: ${tableViewNames.get(table) ?? viewName}`)
                            : [`-- INSERT/UPDATE/DELETE work on ${editableTableName(filePath)} (editable copy).`,
                                '-- After editing run "JustyBase: Save File Edits" to write changes back.']),
                        '',
                        `SELECT * FROM "${defaultViewName}" LIMIT 100;`,
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

            if (format === 'access') {
                vscode.window.showInformationMessage(
                    'Access files are read-only in File SQL mode. Use the JustyBase SQL Editor (Microsoft Access) extension to modify the file.',
                );
                return;
            }

            if (format === 'xlsx' || format === 'xlsb') {
                await saveSpreadsheetEdits(
                    api,
                    filePath,
                    format,
                    typeof details.options?.sheet === 'string' ? details.options.sheet : undefined,
                    active.documentUri,
                );
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

async function openEditableFileSource(
    api: JustyBaseLiteApi,
    request?: EditFileSourceRequest,
): Promise<void> {
    const filePath = request?.filePath?.trim();
    if (!filePath) {
        throw new Error('A local file path is required to open an editable source.');
    }
    const normalizedPath = normalizeFilePath(filePath);
    const format = detectFileDataFormat(normalizedPath);
    if (!format || !['xlsx', 'xlsb', 'csv', 'tsv'].includes(format)) {
        throw new Error('Only XLSX, XLSB, CSV and TSV sources can be opened in editable File SQL mode.');
    }

    const savedConnections = await api.listSavedConnections();
    const connectionName = request?.connectionName?.trim()
        || resolveFileSourceConnectionName(savedConnections.map(connection => connection.details), normalizedPath, 'file');
    const firstSheet = format === 'xlsb'
        ? (await listXlsbSheetNames(normalizedPath))[0]
        : undefined;
    const viewName = sanitizeViewName(normalizedPath);

    await api.openFileSqlSession(
        {
            name: connectionName,
            host: 'local',
            database: normalizedPath,
            user: 'file',
            dbType: 'file',
            options: {
                editable: true,
                ...(format === 'xlsb' && firstSheet ? { sheet: firstSheet } : {}),
            },
        },
        {
            connectionName,
            updateExisting: true,
            content: [
                `-- ${path.basename(normalizedPath)} — File SQL (DuckDB)`,
                '-- Changes are written to the original file by "JustyBase: Save File Edits".',
                format === 'xlsb'
                    ? `-- ${viewName} reads the first sheet; the workbook is updated in place.`
                    : format === 'xlsx'
                        ? `-- ${viewName} reads the first sheet; other workbook sheets are preserved on save.`
                        : '-- Query and edit the generated _edit table, then save the file.',
                `-- INSERT/UPDATE/DELETE work on ${editableTableName(normalizedPath)}.`,
                '',
                `SELECT * FROM "${editableTableName(normalizedPath)}" LIMIT 100;`,
                '',
            ].join('\n'),
        },
    );
}

function isSupportedDataFile(filePath: string): boolean {
    return detectFileDataFormat(filePath) !== undefined;
}

/**
 * Write an editable Excel copy back into the original workbook in place.
 * XlsxUpdater/XlsbUpdater replace only the target sheet, preserving the rest
 * of the workbook (other sheets, styles and pivots).
 */
export async function saveSpreadsheetEdits(
    api: JustyBaseLiteApi,
    filePath: string,
    format: 'xlsx' | 'xlsb',
    sheetName: string | undefined,
    documentUri?: string,
): Promise<void> {
    if (typeof api.executeActiveConnectionSqlQuery !== 'function') {
        throw new Error(`The installed base extension does not support ${format.toUpperCase()} write-back. Update JustyBase SQL Editor.`);
    }

    const tableName = editableTableName(filePath);
    const { columns, rows } = await api.executeActiveConnectionSqlQuery(
        `SELECT * FROM "${tableName}"`,
        documentUri,
    );

    const { XlsxUpdater, XlsbUpdater } = requireSpreadsheetTasks();
    const updater = format === 'xlsx' ? new XlsxUpdater(filePath) : new XlsbUpdater(filePath);
    const availableSheets = updater.getSheetNames();
    const targetSheet = sheetName && availableSheets.includes(sheetName)
        ? sheetName
        : availableSheets[0];
    if (!targetSheet) {
        throw new Error(`${format.toUpperCase()} workbook '${filePath}' contains no sheets.`);
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

/** Map DuckDB cell values to values accepted by spreadsheet-tasks updaters. */
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

function requireSpreadsheetTasks(): {
    XlsxUpdater: new (filePath: string) => SpreadsheetUpdaterLike;
    XlsbUpdater: new (filePath: string) => SpreadsheetUpdaterLike;
} {
    const { XlsxUpdater, XlsbUpdater } = createRequire(__filename)('@justybase/spreadsheet-tasks') as {
        XlsxUpdater: new (filePath: string) => SpreadsheetUpdaterLike;
        XlsbUpdater: new (filePath: string) => SpreadsheetUpdaterLike;
    };
    return { XlsxUpdater, XlsbUpdater };
}

interface SpreadsheetUpdaterLike {
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
            'Data files': ['xlsx', 'xlsb', 'csv', 'tsv', 'parquet', 'avro', 'mdb', 'accdb'],
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
        '-- For Access files, every table is available as "<path>#table=<table>" (read-only).',
        '-- Use normal SQL aliases in your query when convenient.',
        '-- To add more files, run "Add Files to Active File SQL Workspace (DuckDB)".',
        '',
        '-- Available sources:',
    ];

    let defaultViewName = '';
    for (const filePath of filePaths) {
        const normalizedPath = normalizeFilePath(filePath);
        const format = detectFileDataFormat(normalizedPath);
        if (format === 'access') {
            for (const table of await discoverAccessTables(normalizedPath)) {
                const tableViewName = fileTableViewName(normalizedPath, table);
                lines.push(`-- ${quoteIdentifier(tableViewName)}`);
                if (!defaultViewName) {
                    defaultViewName = tableViewName;
                }
            }
        } else {
            lines.push(`-- ${quoteIdentifier(normalizedPath)}`);
            if (!defaultViewName) {
                defaultViewName = normalizedPath;
            }
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
    }

    lines.push(
        '',
        defaultViewName ? `SELECT * FROM ${quoteIdentifier(defaultViewName)} LIMIT 100;` : '-- No viewable sources.',
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

async function discoverAccessTables(filePath: string): Promise<string[]> {
    try {
        return await listAccessTableNames(filePath);
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
