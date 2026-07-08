/**
 * Import Commands - commands for importing data to supported databases
 */

import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { applyGeneratedIdentifierCase } from '../core/dialectTraits';
import { ConnectionManager, type ConnectionDetails as ManagedConnectionDetails } from '../core/connectionManager';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import type { ImportColumnOptions } from '../import/dataImporter';
import {
    getImportDialectLabel,
    importClipboardDataForConnection,
    importDataForConnection,
    resolveImportDialect,
    type SupportedImportDialect,
} from '../import/importDispatcher';
import { ImportWizardService } from '../import/wizard/ImportWizardService';
import type { MetadataCache } from '../metadataCache';
import { ImportWizardView } from '../views/importWizardView';

export interface ImportCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    outputChannel: vscode.OutputChannel;
}

/**
 * Helper to log execution time
 */
function logExecutionTime(outputChannel: vscode.OutputChannel, operation: string, startTime: number): void {
    const duration = Date.now() - startTime;
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${operation} completed in ${duration}ms`);
    outputChannel.show(true);
}

/**
 * Generate auto table name from current database and schema
 */
export async function generateAutoTableName(
    context: vscode.ExtensionContext,
    connectionName: string | undefined,
    connectionManager: ConnectionManager,
    dbType?: string,
    documentUri?: string,
): Promise<string | null> {
    try {
        const normalizedDbType = (dbType || '').trim().toLowerCase();
        let currentDbQuery = 'SELECT CURRENT_CATALOG, CURRENT_SCHEMA';

        if (normalizedDbType === 'db2') {
            currentDbQuery =
                'SELECT CURRENT SERVER AS CURRENT_CATALOG, CURRENT SCHEMA AS CURRENT_SCHEMA FROM SYSIBM.SYSDUMMY1';
        } else if (normalizedDbType === 'sqlite') {
            currentDbQuery = "SELECT 'MAIN' AS CURRENT_CATALOG, 'MAIN' AS CURRENT_SCHEMA";
        }

        const currentDbResult = await runQueryRaw(
            context,
            currentDbQuery,
            true,
            connectionManager,
            connectionName,
            documentUri,
        );

        if (currentDbResult && currentDbResult.data) {
            const dbInfo = queryResultToRows<{ CURRENT_CATALOG?: string; CURRENT_SCHEMA?: string }>(currentDbResult);
            if (dbInfo && dbInfo.length > 0) {
                const database = dbInfo[0].CURRENT_CATALOG || 'SYSTEM';
                const schema = dbInfo[0].CURRENT_SCHEMA || 'ADMIN';

                const now = new Date();
                const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
                const random = Math.floor(Math.random() * 10000)
                    .toString()
                    .padStart(4, '0');
                const generatedTableName = applyGeneratedIdentifierCase(`IMPORT_${dateStr}_${random}`, dbType);

                return `${database}.${schema}.${generatedTableName}`;
            }
        }
    } catch (err: unknown) {
        vscode.window.showErrorMessage(
            `Error getting current database/schema: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return null;
}

/**
 * Detect if clipboard content is a file path or file URI
 * Checks for supported file extensions and path patterns
 */
export function detectFilePath(content: string): boolean {
    let trimmed = content.trim();

    // Empty content is not a file path
    if (!trimmed) {
        return false;
    }

    // Remove surrounding quotes (single or double)
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        trimmed = trimmed.slice(1, -1);
    }

    // Only support csv, xlsx, xlsb file extensions
    const fileExtensions = ['.csv', '.xlsx', '.xlsb'];

    const hasFileExtension = fileExtensions.some((ext) => trimmed.toLowerCase().endsWith(ext));

    if (!hasFileExtension) {
        return false;
    }

    // Check for file URI (file:///C:/path/to/file.csv or file:///path/to/file.csv)
    const hasFileUri = /^file:\/\/\//i.test(trimmed);
    if (hasFileUri) {
        return true;
    }

    // Check for path separators (Windows or Unix)
    const hasPathSeparator = /[\\/]/.test(trimmed);

    // Check for drive letter pattern (Windows)
    const hasDriveLetter = /^[a-zA-Z]:/.test(trimmed);

    // Check for UNC path (Windows network path)
    const hasUncPath = /^\\\\/.test(trimmed);

    // Check for Unix absolute path
    const hasUnixAbsolutePath = /^\//.test(trimmed);

    // Check for relative path patterns
    const hasRelativePath = /^\.{1,2}[\\/]/.test(trimmed);

    // It's likely a file path if it has:
    // - A file extension AND
    // - A path separator OR drive letter OR UNC path OR Unix absolute path OR relative path
    return hasPathSeparator || hasDriveLetter || hasUncPath || hasUnixAbsolutePath || hasRelativePath;
}

/**
 * Convert file URI to file system path
 * Handles file:///C:/path/to/file.csv and file:///path/to/file.csv formats
 * Also handles quoted paths like "D:\DEV\Others\sqls\smallFile.xlsb"
 */
export function fileUriToPath(fileUri: string): string {
    let trimmed = fileUri.trim();

    // Remove surrounding quotes (single or double)
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        trimmed = trimmed.slice(1, -1);
    }

    // Check if it's a file URI
    if (!/^file:\/\/\//i.test(trimmed)) {
        return trimmed; // Return as-is if not a file URI
    }

    // Remove file:/// prefix
    const path = trimmed.substring(8);

    // Handle Windows paths: file:///C:/path/to/file.csv -> C:/path/to/file.csv
    // Unix paths: file:///path/to/file.csv -> /path/to/file.csv
    // The path after file:/// is already in the correct format
    return path;
}

/**
 * Detect if clipboard content is tabbed/tabular data
 * Checks for tab-separated values or other delimiters
 */
function detectTabbedData(content: string): boolean {
    const trimmed = content.trim();

    // Empty content is not tabbed data
    if (!trimmed) {
        return false;
    }

    // Check if it's a file path first (exclude file paths)
    if (detectFilePath(trimmed)) {
        return false;
    }

    // Check for tab-separated data (primary check)
    const lines = trimmed.split('\n').slice(0, 10);
    const hasTabs = lines.some((line) => line.includes('\t'));

    if (hasTabs) {
        return true;
    }

    // Check for other delimiters (comma, semicolon, pipe)
    const delimiters = [',', ';', '|'];
    for (const delimiter of delimiters) {
        const hasDelimiter = lines.some((line) => line.split(delimiter).length > 1);
        if (hasDelimiter) {
            return true;
        }
    }

    return false;
}

interface ImportModeQuickPickItem extends vscode.QuickPickItem {
    value: 'default' | 'form' | 'advanced';
}

interface ColumnQuickPickItem extends vscode.QuickPickItem {
    columnIndex: number;
    inferredType: string;
}

const FORCED_DATA_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

interface ImportCommandContext {
    connectionName: string | undefined;
    connectionDetails: ManagedConnectionDetails;
    sourceFile: string;
    targetTable: string;
}

interface ImportWizardConfiguration {
    defaultMode: 'prompt' | 'simple' | 'advanced';
    previewRowCount: number;
    validationSampleSize: number;
}

interface ImportTargetPromptProfile {
    label: string;
    formatHint: string;
    placeholder: string;
    supportsThreePartName: boolean;
    enforceActiveDatabaseMatch: boolean;
}

const IMPORT_TARGET_PROMPT_PROFILES: Readonly<Record<SupportedImportDialect, ImportTargetPromptProfile>> = {
    netezza: {
        label: 'Netezza',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: false,
    },
    db2: {
        label: 'Db2',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: true,
    },
    postgresql: {
        label: 'PostgreSQL',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: true,
    },
    vertica: {
        label: 'Vertica',
        formatHint: 'TABLE or SCHEMA.TABLE',
        placeholder: 'TABLE or SCHEMA.TABLE',
        supportsThreePartName: false,
        enforceActiveDatabaseMatch: false,
    },
    mssql: {
        label: 'MS SQL Server',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: true,
    },
    snowflake: {
        label: 'Snowflake',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: false,
    },
    oracle: {
        label: 'Oracle',
        formatHint: 'TABLE or SCHEMA.TABLE',
        placeholder: 'TABLE or SCHEMA.TABLE',
        supportsThreePartName: false,
        enforceActiveDatabaseMatch: false,
    },
    mysql: {
        label: 'MySQL',
        formatHint: 'TABLE or DATABASE.TABLE',
        placeholder: 'TABLE or DATABASE.TABLE',
        supportsThreePartName: false,
        enforceActiveDatabaseMatch: false,
    },
    duckdb: {
        label: 'DuckDB',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: false,
    },
    sqlite: {
        label: 'SQLite',
        formatHint: 'TABLE or DATABASE.TABLE',
        placeholder: 'TABLE or DATABASE.TABLE',
        supportsThreePartName: false,
        enforceActiveDatabaseMatch: false,
    },
    unsupported: {
        label: 'database',
        formatHint: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        placeholder: 'TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE',
        supportsThreePartName: true,
        enforceActiveDatabaseMatch: false,
    },
};

function getImportWizardConfiguration(): ImportWizardConfiguration {
    const config = getExtensionConfiguration();
    const defaultModeSetting = config.get<string>('importWizard.defaultMode', 'prompt') ?? 'prompt';
    const previewRowCountSetting = config.get<number>('importWizard.previewRowCount', 10) ?? 10;
    const validationSampleSizeSetting = config.get<number>('importWizard.validationSampleSize', 25) ?? 25;

    return {
        defaultMode: defaultModeSetting === 'simple' || defaultModeSetting === 'advanced' ? defaultModeSetting : 'prompt',
        previewRowCount: [5, 10, 20].includes(previewRowCountSetting) ? previewRowCountSetting : 10,
        validationSampleSize: Math.max(5, Math.min(Math.trunc(validationSampleSizeSetting), 200)),
    };
}

function normalizeForcedDataType(typeName: string): string | null {
    const normalized = typeName.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!FORCED_DATA_TYPE_PATTERN.test(normalized)) {
        return null;
    }
    return normalized;
}

function getImportTargetPromptProfile(dbType?: string): ImportTargetPromptProfile {
    return IMPORT_TARGET_PROMPT_PROFILES[resolveImportDialect(dbType)];
}

function validateImportTargetTableInput(
    value: string | undefined,
    connectionDetails: ManagedConnectionDetails,
): string | null {
    if (!value || value.trim().length === 0) {
        return null;
    }

    const normalizedValue = value.trim();
    const profile = getImportTargetPromptProfile(connectionDetails.dbType);
    const rawParts = normalizedValue.split('.').map((part) => part.trim());
    if (rawParts.some((part) => part.length === 0)) {
        return `Invalid target table format. Use ${profile.formatHint}.`;
    }

    if (rawParts.length > 3) {
        return `Invalid target table format. Use ${profile.formatHint}.`;
    }

    if (rawParts.length === 3 && !profile.supportsThreePartName) {
        return `Three-part target names are not supported for ${profile.label}. Use ${profile.formatHint}.`;
    }

    if (rawParts.length === 3 && profile.enforceActiveDatabaseMatch) {
        const activeDatabase = connectionDetails.database?.trim();
        if (activeDatabase && rawParts[0].toUpperCase() !== activeDatabase.toUpperCase()) {
            return `${profile.label} import runs against active database "${activeDatabase}". ` +
                `Provided database "${rawParts[0]}" does not match the active connection.`;
        }
    }

    return null;
}

function buildTargetTableInputOptions(connectionDetails: ManagedConnectionDetails): vscode.InputBoxOptions {
    const profile = getImportTargetPromptProfile(connectionDetails.dbType);
    const dialectLabel = getImportDialectLabel(connectionDetails.dbType);

    return {
        prompt: `Enter target table name for ${dialectLabel} import (leave empty for auto-generated name)`,
        placeHolder: profile.placeholder,
        validateInput: (value) => validateImportTargetTableInput(value, connectionDetails),
    };
}

async function ensureSnowflakeConnection(
    connectionName: string | undefined,
    connectionManager: ConnectionManager,
): Promise<string | undefined> {
    if (!connectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return undefined;
    }

    if (connectionManager.getConnectionDatabaseKind(connectionName) !== 'snowflake') {
        vscode.window.showErrorMessage('This command is available only for Snowflake connections.');
        return undefined;
    }

    return connectionName;
}

async function openSnowflakeWorkflowDocument(
    connectionName: string,
    content: string,
    language: string,
    connectionManager: ConnectionManager,
): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ content, language });
    connectionManager.setDocumentConnection(document.uri.toString(), connectionName);
    await vscode.window.showTextDocument(document, { preview: false });
}

async function promptSnowflakeTargetTable(defaultValue?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: 'Enter target table name',
        value: defaultValue,
        placeHolder: 'DATABASE.SCHEMA.TABLE or SCHEMA.TABLE',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Target table name is required.';
            }
            return null;
        },
    });
}

async function promptSnowflakeStageReference(): Promise<{ stageName: string; stagePath?: string } | undefined> {
    const stageName = await vscode.window.showInputBox({
        prompt: 'Enter Snowflake stage name',
        placeHolder: 'RAW_STAGE or DB.SCHEMA.RAW_STAGE',
        validateInput: (value) => (!value || !value.trim() ? 'Stage name is required.' : null),
    });
    if (!stageName) {
        return undefined;
    }

    const stagePath = await vscode.window.showInputBox({
        prompt: 'Optional stage path prefix',
        placeHolder: 'incoming/orders/',
        validateInput: () => null,
    });

    return {
        stageName: stageName.trim(),
        stagePath: stagePath?.trim() || undefined,
    };
}

async function buildFormImportOptions(
    sourceFile: string,
    targetTable: string,
    dbType?: string,
): Promise<ImportColumnOptions | undefined> {
    const { createTabularDataImporter } = await import('../import/tabularDataImporter');
    const previewImporter = createTabularDataImporter(sourceFile, targetTable, { kind: dbType });
    await previewImporter.analyzeDataTypes();

    const mappings = previewImporter.getColumnMappings();
    if (mappings.length === 0) {
        vscode.window.showErrorMessage('Unable to detect columns for import.');
        return undefined;
    }

    const columnItems: ColumnQuickPickItem[] = mappings.map((mapping, index) => ({
        label: mapping.targetColumn,
        description: `Source: ${mapping.sourceColumn}`,
        detail: `Auto type: ${mapping.dataType}`,
        columnIndex: index,
        inferredType: mapping.dataType,
    }));

    const selectedColumns = await vscode.window.showQuickPick(columnItems, {
        canPickMany: true,
        placeHolder: 'Form import: select columns to import',
    });

    if (!selectedColumns) {
        return undefined;
    }

    if (selectedColumns.length === 0) {
        vscode.window.showWarningMessage('Select at least one column to continue import.');
        return undefined;
    }

    const selectedColumnIndexes = selectedColumns
        .map((item) => item.columnIndex)
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a - b);

    const forcedTypeColumns = await vscode.window.showQuickPick(selectedColumns, {
        canPickMany: true,
        placeHolder: 'Select columns that should use a forced data type (optional)',
    });

    if (!forcedTypeColumns) {
        return undefined;
    }

    const forcedColumnTypes: Record<number, string> = {};
    for (const columnItem of forcedTypeColumns) {
        const forcedTypeInput = await vscode.window.showInputBox({
            prompt: `Forced data type for column ${columnItem.label}`,
            placeHolder: 'Examples: BIGINT, NUMERIC(18,2), DATE, DATETIME, NVARCHAR(255)',
            value: columnItem.inferredType,
            validateInput: (value) => {
                if (!value || !value.trim()) {
                    return 'Data type is required for forced mode.';
                }
                return normalizeForcedDataType(value) ? null : 'Invalid data type format.';
            },
        });

        if (forcedTypeInput === undefined) {
            return undefined;
        }

        const normalizedType = normalizeForcedDataType(forcedTypeInput);
        if (!normalizedType) {
            vscode.window.showErrorMessage(`Invalid forced data type for column ${columnItem.label}`);
            return undefined;
        }

        forcedColumnTypes[columnItem.columnIndex] = normalizedType;
    }

    if (Object.keys(forcedColumnTypes).length === 0) {
        return { selectedColumnIndexes };
    }

    return {
        selectedColumnIndexes,
        forcedColumnTypes,
    };
}

async function resolveSourceFile(filePath?: string | vscode.Uri): Promise<string | undefined> {
    let normalizedFilePath = '';
    if (filePath) {
        normalizedFilePath = typeof filePath === 'string' ? filePath : filePath.fsPath || '';
    }

    const fs = await import('fs');
    const dataExtensions = ['.csv', '.txt', '.tsv', '.xlsx', '.xlsb', '.parquet'];
    const ext = normalizedFilePath ? normalizedFilePath.toLowerCase().slice(normalizedFilePath.lastIndexOf('.')) : '';
    const isDataFile = dataExtensions.includes(ext);

    const isValidFilePath =
        normalizedFilePath &&
        isDataFile &&
        !normalizedFilePath.startsWith('untitled:') &&
        !normalizedFilePath.startsWith('vscode:') &&
        fs.existsSync(normalizedFilePath);

    if (isValidFilePath) {
        return normalizedFilePath;
    }

    const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
            'Data Files': ['csv', 'txt', 'xlsx', 'xlsb'],
            'Delimited Files': ['csv', 'txt'],
            'Excel Files': ['xlsx', 'xlsb'],
            'All Files': ['*'],
        },
        openLabel: 'Select file to import',
    });

    if (!fileUris || fileUris.length === 0) {
        return undefined;
    }

    return fileUris[0].fsPath;
}

async function resolveAdvancedTargetTable(
    context: vscode.ExtensionContext,
    connectionName: string | undefined,
    connectionManager: ConnectionManager,
    connectionDetails: ManagedConnectionDetails,
    documentUri?: string,
): Promise<string | undefined> {
    const targetTableName = await vscode.window.showInputBox({
        prompt: 'Enter target table name (database and schema can be selected in the wizard)',
        placeHolder: 'TABLE_NAME',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return null;
            }
            if (value.includes('.')) {
                return 'Enter only the table name. Choose database and schema in the Advanced Import Wizard.';
            }
            return null;
        },
    });

    if (targetTableName === undefined) {
        return undefined;
    }

    if (!targetTableName || targetTableName.trim().length === 0) {
        const autoName = await generateAutoTableName(
            context,
            connectionName,
            connectionManager,
            connectionDetails.dbType,
            documentUri,
        );
        if (!autoName) {
            return undefined;
        }
        vscode.window.showInformationMessage(`Auto-generated table name: ${autoName}`);
        return autoName;
    }

    return targetTableName.trim();
}

async function resolveTargetTable(
    context: vscode.ExtensionContext,
    connectionName: string | undefined,
    connectionManager: ConnectionManager,
    connectionDetails: ManagedConnectionDetails,
    documentUri?: string,
): Promise<string | undefined> {
    const targetTable = await vscode.window.showInputBox(buildTargetTableInputOptions(connectionDetails));

    if (targetTable === undefined) {
        return undefined;
    }

    if (!targetTable || targetTable.trim().length === 0) {
        const autoName = await generateAutoTableName(
            context,
            connectionName,
            connectionManager,
            connectionDetails.dbType,
            documentUri,
        );
        if (!autoName) {
            return undefined;
        }
        vscode.window.showInformationMessage(`Auto-generated table name: ${autoName}`);
        return autoName;
    }

    return targetTable.trim();
}

async function resolveImportCommandContext(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    filePath?: string | vscode.Uri,
): Promise<ImportCommandContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    const documentUri = editor?.document?.uri?.toString();
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    const connectionDetails = await connectionManager.getConnectionDetailsForImport(documentUri, connectionName);
    if (!connectionDetails) {
        throw new Error('Connection not configured. Please connect first.');
    }

    const sourceFile = await resolveSourceFile(filePath);
    if (!sourceFile) {
        return undefined;
    }

    const targetTable = await resolveTargetTable(
        context,
        connectionName,
        connectionManager,
        connectionDetails,
        documentUri,
    );
    if (!targetTable) {
        return undefined;
    }

    return {
        connectionName,
        connectionDetails,
        sourceFile,
        targetTable,
    };
}

async function resolveAdvancedImportCommandContext(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    filePath?: string | vscode.Uri,
): Promise<ImportCommandContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    const documentUri = editor?.document?.uri?.toString();
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    const connectionDetails = await connectionManager.getConnectionDetailsForImport(documentUri, connectionName);
    if (!connectionDetails) {
        throw new Error('Connection not configured. Please connect first.');
    }

    const sourceFile = await resolveSourceFile(filePath);
    if (!sourceFile) {
        return undefined;
    }

    const targetTable = await resolveAdvancedTargetTable(
        context,
        connectionName,
        connectionManager,
        connectionDetails,
        documentUri,
    );
    if (!targetTable) {
        return undefined;
    }

    return {
        connectionName,
        connectionDetails,
        sourceFile,
        targetTable,
    };
}

async function resolveImportMode(): Promise<'default' | 'form' | 'advanced' | undefined> {
    const config = getImportWizardConfiguration();
    if (config.defaultMode === 'simple') {
        return 'default';
    }
    if (config.defaultMode === 'advanced') {
        return 'advanced';
    }

    const importOptions = await vscode.window.showQuickPick<ImportModeQuickPickItem>(
        [
            {
                label: 'Simple Import',
                description: 'Current best-effort import flow',
                value: 'default',
            },
            {
                label: 'Advanced Import Wizard',
                description: 'Open the interactive preview, validation, and SQL wizard',
                value: 'advanced',
            },
            {
                label: 'Form Import',
                description: 'Choose columns and optionally force data types',
                value: 'form',
            },
        ],
        {
            placeHolder: 'Select import mode',
        },
    );

    return importOptions?.value;
}

async function openAdvancedImportWizard(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    metadataCache: MetadataCache,
    importWizardService: ImportWizardService,
    resolvedContext: ImportCommandContext,
): Promise<void> {
    const wizardConfig = getImportWizardConfiguration();
    await ImportWizardView.createOrShow(context, context.extensionUri, connectionManager, metadataCache, importWizardService, {
        filePath: resolvedContext.sourceFile,
        targetTable: resolvedContext.targetTable,
        connectionDetails: resolvedContext.connectionDetails,
        connectionName: resolvedContext.connectionName,
        previewRowCount: wizardConfig.previewRowCount,
        validationSampleSize: wizardConfig.validationSampleSize,
    });
}

/**
 * Register all import-related commands
 */
export function registerImportCommands(deps: ImportCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, metadataCache, outputChannel } = deps;
    const importWizardService = new ImportWizardService();

    return [
        // Import Data from Clipboard
        vscode.commands.registerCommand('netezza.importClipboard', async () => {
            try {
                const editor = vscode.window.activeTextEditor;
                const documentUri = editor?.document?.uri?.toString();
                const connectionName = connectionManager.getConnectionForExecution(documentUri);
                const connectionDetails = await connectionManager.getConnectionDetailsForImport(
                    documentUri,
                    connectionName,
                );
                if (!connectionDetails) {
                    throw new Error('Connection not configured. Please connect first.');
                }

                const targetTable = await vscode.window.showInputBox({
                    ...buildTargetTableInputOptions(connectionDetails),
                });

                if (targetTable === undefined) return;

                let finalTableName: string;
                if (!targetTable || targetTable.trim().length === 0) {
                    const autoName = await generateAutoTableName(
                        context,
                        connectionName,
                        connectionManager,
                        connectionDetails.dbType,
                        documentUri,
                    );
                    if (!autoName) return;
                    finalTableName = autoName;
                    vscode.window.showInformationMessage(`Auto-generated table name: ${finalTableName}`);
                } else {
                    finalTableName = targetTable.trim();
                }

                const formatOptions = await vscode.window.showQuickPick(
                    [
                        {
                            label: 'Auto-detect',
                            description: 'Automatically detect clipboard format',
                            value: null,
                        },
                        {
                            label: 'Plain Text',
                            description: 'Force plain text processing with delimiter detection',
                            value: 'TEXT',
                        },
                    ],
                    {
                        placeHolder: 'Select clipboard data format',
                    },
                );

                if (!formatOptions) return;

                const startTime = Date.now();

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: 'Importing clipboard data...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        let lastLoggedMessage = '';
                        const reportProgress = (message: string, increment?: number, logToOutput: boolean = true) => {
                            if (token.isCancellationRequested) return;
                            progress.report({ message, increment });
                            if (logToOutput && message !== lastLoggedMessage) {
                                outputChannel.appendLine(`[Clipboard Import] ${message}`);
                                lastLoggedMessage = message;
                            }
                        };

                        if (token.isCancellationRequested) return;

                        const result: {
                            success: boolean;
                            message: string;
                            details?: {
                                rowsProcessed?: number;
                                columns?: number;
                                format?: string;
                            };
                        } = await importClipboardDataForConnection(
                            finalTableName,
                            connectionDetails,
                            formatOptions.value,
                            {},
                            reportProgress,
                        );

                        if (!result.success) {
                            throw new Error(result.message);
                        }

                        if (result.details) {
                            outputChannel.appendLine(
                                `[Clipboard Import] Rows processed: ${result.details.rowsProcessed}`,
                            );
                            outputChannel.appendLine(`[Clipboard Import] Columns: ${result.details.columns}`);
                            outputChannel.appendLine(`[Clipboard Import] Format: ${result.details.format}`);
                        }
                    },
                );

                logExecutionTime(outputChannel, 'Import Clipboard Data', startTime);
                vscode.window
                    .showInformationMessage(
                        `Clipboard data imported successfully to table: ${finalTableName}`,
                        'Copy Table Name',
                    )
                    .then((action) => {
                        if (action === 'Copy Table Name') {
                            vscode.env.clipboard.writeText(finalTableName);
                            vscode.window.showInformationMessage('Table name copied to clipboard');
                        }
                    });
                void vscode.commands.executeCommand('netezza.refreshSchema');
            } catch (err: unknown) {
                vscode.window.showErrorMessage(
                    `Error importing clipboard data: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }),

        vscode.commands.registerCommand('netezza.importDataAdvanced', async (filePath?: string | vscode.Uri) => {
            try {
                const resolvedContext = await resolveAdvancedImportCommandContext(context, connectionManager, filePath);
                if (!resolvedContext) {
                    return;
                }

                await openAdvancedImportWizard(context, connectionManager, metadataCache, importWizardService, resolvedContext);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(
                    `Error opening advanced import wizard: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }),

        vscode.commands.registerCommand('netezza.importData', async (fileArg?: string | vscode.Uri | { filePath?: string | vscode.Uri; mode?: string }) => {
            try {
                let filePath: string | vscode.Uri | undefined;
                let forcedMode: string | undefined;
                if (fileArg && typeof fileArg === 'object' && 'mode' in fileArg) {
                    filePath = fileArg.filePath;
                    forcedMode = fileArg.mode;
                } else {
                    filePath = fileArg as string | vscode.Uri | undefined;
                }
                const resolvedContext = await resolveImportCommandContext(context, connectionManager, filePath);
                if (!resolvedContext) {
                    return;
                }

                const importMode = forcedMode || await resolveImportMode();
                if (!importMode) {
                    return;
                }

                let formImportOptions: ImportColumnOptions | undefined;
                if (importMode === 'advanced') {
                    await openAdvancedImportWizard(context, connectionManager, metadataCache, importWizardService, resolvedContext);
                    return;
                }

                if (importMode === 'form') {
                    formImportOptions = await buildFormImportOptions(
                        resolvedContext.sourceFile,
                        resolvedContext.targetTable,
                        resolvedContext.connectionDetails.dbType,
                    );
                    if (!formImportOptions) {
                        return;
                    }
                }

                const startTime = Date.now();
                let generatedSnowflakeWorkflow = false;

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: 'Importing data...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        let lastLoggedMessage = '';
                        const reportProgress = (message: string, increment?: number, logToOutput: boolean = true) => {
                            if (token.isCancellationRequested) return;
                            progress.report({ message, increment });
                            if (logToOutput && message !== lastLoggedMessage) {
                                outputChannel.appendLine(`[Import] ${message}`);
                                lastLoggedMessage = message;
                            }
                        };

                        if (token.isCancellationRequested) return;

                        const result: {
                            success: boolean;
                            message: string;
                            details?: {
                                rowsProcessed?: number;
                                columns?: number;
                                detectedDelimiter?: string;
                                snowflakeWorkflow?: {
                                    workflowMarkdown: string;
                                };
                            };
                        } = await importDataForConnection(
                            resolvedContext.sourceFile,
                            resolvedContext.targetTable,
                            resolvedContext.connectionDetails,
                            reportProgress,
                            undefined,
                            formImportOptions,
                        );

                        const workflowMarkdown = result.details?.snowflakeWorkflow?.workflowMarkdown;
                        if (workflowMarkdown) {
                            generatedSnowflakeWorkflow = true;
                            await openSnowflakeWorkflowDocument(
                                resolvedContext.connectionName || connectionManager.getActiveConnectionName() || '',
                                workflowMarkdown,
                                'markdown',
                                connectionManager,
                            );
                            vscode.window.showInformationMessage(
                                'Snowflake staged load workflow generated. Review the SQL, upload the file to a stage, and run the COPY INTO statement when ready.',
                            );
                            return;
                        }

                        if (!result.success) {
                            throw new Error(result.message);
                        }

                        if (result.details) {
                            outputChannel.appendLine(`[Import] Rows processed: ${result.details.rowsProcessed}`);
                            outputChannel.appendLine(`[Import] Columns: ${result.details.columns}`);
                            outputChannel.appendLine(`[Import] Delimiter: ${result.details.detectedDelimiter}`);
                        }
                    },
                );

                if (generatedSnowflakeWorkflow) {
                    logExecutionTime(outputChannel, 'Prepare Snowflake Import Workflow', startTime);
                    return;
                }

                logExecutionTime(outputChannel, 'Import Data', startTime);
                vscode.window
                    .showInformationMessage(`Data imported successfully to table: ${resolvedContext.targetTable}`, 'Copy Table Name')
                    .then((action) => {
                        if (action === 'Copy Table Name') {
                            vscode.env.clipboard.writeText(resolvedContext.targetTable);
                            vscode.window.showInformationMessage('Table name copied to clipboard');
                        }
                    });
                void vscode.commands.executeCommand('netezza.refreshSchema');
            } catch (err: unknown) {
                vscode.window.showErrorMessage(
                    `Error importing data: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }),

        vscode.commands.registerCommand('netezza.snowflake.prepareStageImport', async () => {
            const editor = vscode.window.activeTextEditor;
            const documentUri = editor?.document?.uri?.toString();
            const connectionName = await ensureSnowflakeConnection(
                connectionManager.getConnectionForExecution(documentUri) ||
                    connectionManager.getActiveConnectionName() ||
                    undefined,
                connectionManager,
            );
            if (!connectionName) {
                return;
            }

            const targetTable = await promptSnowflakeTargetTable();
            if (!targetTable) {
                return;
            }

            const stage = await promptSnowflakeStageReference();
            if (!stage) {
                return;
            }

            const fileFormatName = await vscode.window.showInputBox({
                prompt: 'Optional Snowflake file format name',
                placeHolder: 'MY_CSV_FORMAT',
                validateInput: () => null,
            });
            const { buildSnowflakeCopyIntoTableSql, buildSnowflakeStageUsageGuide } =
                await import('../../extensions/snowflake/src/snowflakeImportExport');

            const sql = buildSnowflakeCopyIntoTableSql({
                tableName: targetTable.trim(),
                stage,
                fileFormatName: fileFormatName?.trim() || undefined,
                onError: 'ABORT_STATEMENT',
                matchByColumnName: 'CASE_INSENSITIVE',
            });
            const guide = [
                buildSnowflakeStageUsageGuide(stage),
                '',
                '## Selected Target',
                '',
                `- Table: \`${targetTable.trim()}\``,
                '',
                '## Generated SQL',
                '',
                '```sql',
                sql,
                '```',
            ].join('\n');
            await openSnowflakeWorkflowDocument(connectionName, guide, 'markdown', connectionManager);
        }),

        vscode.commands.registerCommand('netezza.snowflake.prepareStageExport', async () => {
            const editor = vscode.window.activeTextEditor;
            const documentUri = editor?.document?.uri?.toString();
            const connectionName = await ensureSnowflakeConnection(
                connectionManager.getConnectionForExecution(documentUri) ||
                    connectionManager.getActiveConnectionName() ||
                    undefined,
                connectionManager,
            );
            if (!connectionName) {
                return;
            }

            const targetTable = await promptSnowflakeTargetTable();
            if (!targetTable) {
                return;
            }

            const stage = await promptSnowflakeStageReference();
            if (!stage) {
                return;
            }

            const fileFormatName = await vscode.window.showInputBox({
                prompt: 'Optional Snowflake file format name',
                placeHolder: 'MY_CSV_FORMAT',
                validateInput: () => null,
            });
            const { buildSnowflakeCopyIntoStageSql, buildSnowflakeStageUsageGuide } =
                await import('../../extensions/snowflake/src/snowflakeImportExport');

            const sql = buildSnowflakeCopyIntoStageSql({
                tableName: targetTable.trim(),
                stage,
                fileFormatName: fileFormatName?.trim() || undefined,
                header: true,
                overwrite: true,
                single: false,
            });
            const guide = [
                buildSnowflakeStageUsageGuide(stage),
                '',
                '## Selected Source',
                '',
                `- Table: \`${targetTable.trim()}\``,
                '',
                '## Generated SQL',
                '',
                '```sql',
                sql,
                '```',
            ].join('\n');
            await openSnowflakeWorkflowDocument(connectionName, guide, 'markdown', connectionManager);
        }),

        // Smart Paste (Auto-detect file paths or tabular data)
        vscode.commands.registerCommand('netezza.smartPaste', async () => {
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) return;

                const clipboardContent = await vscode.env.clipboard.readText();

                // Check if clipboard contains a file path
                const trimmedContent = clipboardContent ? clipboardContent.trim() : '';
                const isFilePath = trimmedContent && detectFilePath(trimmedContent);

                if (isFilePath) {
                    const action = await vscode.window.showQuickPick(
                        [
                            {
                                label: '📁 Import file to database table',
                                description: `Detected file path: ${trimmedContent}`,
                                value: 'importFile',
                            },
                            {
                                label: '📝 Paste as text',
                                description: 'Paste clipboard content as plain text',
                                value: 'paste',
                            },
                        ],
                        {
                            placeHolder: 'Detected file path in clipboard - choose an action',
                        },
                    );

                    if (action?.value === 'importFile') {
                        // Convert file URI to file system path if needed
                        const filePath = fileUriToPath(trimmedContent);

                        // Check if file exists
                        const fs = await import('fs');
                        if (fs.existsSync(filePath)) {
                            // Trigger import with the file path
                            await vscode.commands.executeCommand('netezza.importData', filePath);
                        } else {
                            vscode.window.showErrorMessage(`File not found: ${filePath}`);
                        }
                        return;
                    }
                } else {
                    // Detect if clipboard contains tabbed/tabular data
                    const hasTabbedData = detectTabbedData(clipboardContent);

                    if (hasTabbedData) {
                        const action = await vscode.window.showQuickPick(
                            [
                                {
                                    label: '📊 Import to database table',
                                    description: 'Detected tabular data - import to database',
                                    value: 'import',
                                },
                                {
                                    label: '📝 Paste as text',
                                    description: 'Paste clipboard content as plain text',
                                    value: 'paste',
                                },
                            ],
                            {
                                placeHolder: 'Detected tabular data in clipboard - choose an action',
                            },
                        );

                        if (action?.value === 'import') {
                            vscode.commands.executeCommand('netezza.importClipboard');
                            return;
                        }
                    }
                }

                // Default: paste as text
                const selection = activeEditor.selection;
                await activeEditor.edit((editBuilder) => {
                    editBuilder.replace(selection, clipboardContent);
                });
            } catch (error: unknown) {
                vscode.window.showErrorMessage(
                    `Error during paste: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }),

        // Import with picker — asks clipboard/file then simple/advanced (mode skipped for clipboard)
        vscode.commands.registerCommand('netezza.importWithPicker', async () => {
            const source = await vscode.window.showQuickPick(
                [
                    { label: '$(clippy) From Clipboard', description: 'Import data from clipboard', value: 'clipboard' },
                    { label: '$(file) From File', description: 'Import data from a file (CSV, TSV, etc.)', value: 'file' },
                ],
                { placeHolder: 'Select data source' },
            );
            if (!source) return;

            if (source.value === 'clipboard') {
                await vscode.commands.executeCommand('netezza.importClipboard');
                return;
            }

            const mode = await vscode.window.showQuickPick(
                [
                    { label: '$(zap) Simple', description: 'Auto-detect settings and import', value: 'simple' },
                    { label: '$(table) Advanced', description: 'Open advanced import wizard', value: 'advanced' },
                ],
                { placeHolder: 'Select import mode' },
            );
            if (!mode) return;

            if (mode.value === 'advanced') {
                await vscode.commands.executeCommand('netezza.importDataAdvanced');
            } else {
                await vscode.commands.executeCommand('netezza.importData', { mode: 'simple' });
            }
        }),

        // Register paste detection for automatic file path detection
        registerPasteDetection(context),
    ];
}

/**
 * Register paste detection listener to automatically detect file paths being pasted
 */
function registerPasteDetection(_context: vscode.ExtensionContext): vscode.Disposable {
    let lastPasteTime = 0;
    const PASTE_DEBOUNCE_MS = 500;

    return vscode.workspace.onDidChangeTextDocument(async (event) => {
        // Only process SQL files
        if (event.document.languageId !== 'sql') {
            return;
        }

        // Check if this is a paste operation (single change, no deletion, text added)
        const isPaste =
            event.contentChanges.length === 1 &&
            event.contentChanges[0].rangeLength === 0 &&
            event.contentChanges[0].text.length > 0;

        if (!isPaste) {
            return;
        }

        // Debounce to avoid multiple detections
        const now = Date.now();
        if (now - lastPasteTime < PASTE_DEBOUNCE_MS) {
            return;
        }
        lastPasteTime = now;

        const pastedText = event.contentChanges[0].text.trim();

        // Check if pasted text is a file path
        if (detectFilePath(pastedText)) {
            const filePath = fileUriToPath(pastedText);

            // Check if file exists
            const fs = await import('fs');
            if (fs.existsSync(filePath)) {
                const action = await vscode.window.showQuickPick(
                    [
                        {
                            label: '📁 Import file to database table',
                            description: `Detected file path: ${filePath}`,
                            value: 'importFile',
                        },
                        {
                            label: '📝 Keep pasted text',
                            description: 'Keep the file path in the editor',
                            value: 'keep',
                        },
                    ],
                    {
                        placeHolder: 'Detected file path in clipboard - choose an action',
                    },
                );

                if (action?.value === 'importFile') {
                    // Remove the pasted file path from the editor
                    const editor = vscode.window.activeTextEditor;
                    if (editor && editor.document === event.document) {
                        const change = event.contentChanges[0];
                        // Calculate range of pasted text - change.range is position BEFORE insertion
                        const startPos = change.range.start;
                        const endPos = startPos.translate(0, change.text.length);
                        const pastedRange = new vscode.Range(startPos, endPos);
                        await editor.edit((editBuilder) => {
                            editBuilder.delete(pastedRange);
                        });
                    }

                    // Trigger import with the file path
                    try {
                        await vscode.commands.executeCommand('netezza.importData', filePath);
                    } catch (err: unknown) {
                        const errorMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Import failed: ${errorMsg}`);
                        console.error('Import error:', err);
                    }
                }
            }
        }
    });
}
