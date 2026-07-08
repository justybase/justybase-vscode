/**
 * Unit tests for commands/importCommands.ts
 * Tests import command registration and helper functions
 */

import * as vscode from 'vscode';
import {
    registerImportCommands,
    ImportCommandsDependencies,
    detectFilePath,
    fileUriToPath,
    generateAutoTableName,
} from '../commands/importCommands';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { importClipboardDataToNetezza } from '../import/clipboardImporter';
import { importDataToNetezza } from '../import/dataImporter';
import { importClipboardDataToDb2, importDataToDb2 } from '../import/db2Importer';
import { importClipboardDataToPostgreSql, importDataToPostgreSql } from '../import/postgresqlImporter';
import { ImportWizardView } from '../views/importWizardView';

// Mock vscode module
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
        executeCommand: jest.fn(),
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn().mockResolvedValue(undefined),
        showInputBox: jest.fn(),
        showQuickPick: jest.fn(),
        showOpenDialog: jest.fn(),
        withProgress: jest.fn(),
        showTextDocument: jest.fn(),
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
        })),
        onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
        openTextDocument: jest.fn(),
    },
    ProgressLocation: {
        Notification: 1,
    },
    env: {
        clipboard: {
            readText: jest.fn(),
            writeText: jest.fn(),
        },
        openExternal: jest.fn(),
    },
    Uri: {
        file: jest.fn((path) => ({ fsPath: path })),
    },
    Range: jest.fn((start, end) => ({ start, end })),
}));

// Mock connection manager
jest.mock('../core/connectionManager', () => ({
    ConnectionManager: jest.fn(),
}));

jest.mock('../import/wizard/ImportWizardService', () => ({
    ImportWizardService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../views/importWizardView', () => ({
    ImportWizardView: {
        createOrShow: jest.fn(),
    },
}));

// Mock queryRunner
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(),
}));

// Mock clipboard importer
jest.mock('../import/clipboardImporter', () => ({
    importClipboardDataToNetezza: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, format: 'CSV' },
    }),
}));

// Mock data importer
jest.mock('../import/dataImporter', () => ({
    NetezzaImporter: jest.fn().mockImplementation(() => ({
        analyzeDataTypes: jest.fn().mockResolvedValue([]),
        getSourceHeaders: jest.fn().mockReturnValue(['id', 'amount']),
        getColumnMappings: jest.fn().mockReturnValue([
            {
                sourceColumn: 'id',
                targetColumn: 'ID',
                dataType: 'BIGINT',
            },
            {
                sourceColumn: 'amount',
                targetColumn: 'AMOUNT',
                dataType: 'NUMERIC(16,2)',
            },
        ]),
        getCsvDelimiter: jest.fn().mockReturnValue(','),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
    })),
    importDataToNetezza: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, detectedDelimiter: ',' },
    }),
}));

// Mock DB2 importer
jest.mock('../import/db2Importer', () => ({
    importClipboardDataToDb2: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, format: 'CLIPBOARD' },
    }),
    importDataToDb2: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, detectedDelimiter: ',' },
    }),
}));

jest.mock('../import/postgresqlImporter', () => ({
    importClipboardDataToPostgreSql: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, format: 'CLIPBOARD' },
    }),
    importDataToPostgreSql: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        details: { rowsProcessed: 10, columns: 5, detectedDelimiter: ',' },
    }),
}));

// Mock fs module
jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
}));

function createImportConnectionManager(
    connectionDetails: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
    return {
        getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
        getConnection: jest.fn().mockResolvedValue(connectionDetails),
        getEffectiveDatabase: jest.fn().mockResolvedValue(
            typeof connectionDetails.database === 'string' ? connectionDetails.database : 'testdb',
        ),
        getConnectionDetailsForImport: jest.fn().mockResolvedValue(connectionDetails),
        ...overrides,
    };
}

describe('commands/importCommands', () => {
    let mockContext: vscode.ExtensionContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockConnectionManager: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockOutputChannel: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockMetadataCache: any;

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.window.withProgress as jest.Mock).mockImplementation(async (_options, callback) => {
            return callback({ report: jest.fn() }, { isCancellationRequested: false });
        });
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('admin.target_table');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: 'Simple Import',
            value: 'default',
        });
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: 'D:\\data\\input.csv' }]);
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('');

        mockContext = { extensionUri: { fsPath: '/test/extension' } } as vscode.ExtensionContext;
        mockConnectionManager = {
            getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
            getConnection: jest.fn().mockResolvedValue({
                name: 'test-connection',
                host: 'localhost',
                port: 5480,
                database: 'testdb',
                username: 'user',
            }),
            getEffectiveDatabase: jest.fn().mockResolvedValue('testdb'),
            getConnectionDetailsForImport: jest.fn(async (documentUri?: string, _connectionName?: string, droppedDatabase?: string) => {
                const details = {
                    name: 'test-connection',
                    host: 'localhost',
                    port: 5480,
                    database: 'testdb',
                    username: 'user',
                };
                if (droppedDatabase) {
                    return { ...details, database: droppedDatabase };
                }
                if (documentUri) {
                    const effectiveDb = await mockConnectionManager.getEffectiveDatabase(documentUri);
                    if (effectiveDb) {
                        return { ...details, database: effectiveDb };
                    }
                }
                return details;
            }),
        };
        mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
        };
        mockMetadataCache = {};
    });

    describe('detectFilePath', () => {
        it('should return false for empty string', () => {
            expect(detectFilePath('')).toBe(false);
        });

        it('should return false for whitespace only', () => {
            expect(detectFilePath('   ')).toBe(false);
        });

        it('should return false for non-file content', () => {
            expect(detectFilePath('SELECT * FROM table')).toBe(false);
        });

        it('should return false for file without supported extension', () => {
            expect(detectFilePath('C:\\path\\to\\file.txt')).toBe(false);
        });

        it('should detect Windows CSV file path', () => {
            expect(detectFilePath('C:\\path\\to\\file.csv')).toBe(true);
        });

        it('should detect Windows XLSX file path', () => {
            expect(detectFilePath('C:\\path\\to\\file.xlsx')).toBe(true);
        });

        it('should detect Windows XLSB file path', () => {
            expect(detectFilePath('C:\\path\\to\\file.xlsb')).toBe(true);
        });

        it('should detect Unix CSV file path', () => {
            expect(detectFilePath('/path/to/file.csv')).toBe(true);
        });

        it('should detect file URI', () => {
            expect(detectFilePath('file:///C:/path/to/file.csv')).toBe(true);
        });

        it('should detect quoted file path', () => {
            expect(detectFilePath('"C:\\path\\to\\file.csv"')).toBe(true);
        });

        it('should detect single-quoted file path', () => {
            expect(detectFilePath("'/path/to/file.csv'")).toBe(true);
        });

        it('should detect UNC path', () => {
            expect(detectFilePath('\\\\server\\share\\file.csv')).toBe(true);
        });

        it('should detect relative path', () => {
            expect(detectFilePath('./data/file.csv')).toBe(true);
        });

        it('should detect parent relative path', () => {
            expect(detectFilePath('../data/file.csv')).toBe(true);
        });

        it('should detect drive letter path', () => {
            expect(detectFilePath('D:data\\file.csv')).toBe(true);
        });
    });

    describe('fileUriToPath', () => {
        it('should return unchanged if not a file URI', () => {
            expect(fileUriToPath('C:\\path\\to\\file.csv')).toBe('C:\\path\\to\\file.csv');
        });

        it('should convert Windows file URI to path', () => {
            expect(fileUriToPath('file:///C:/path/to/file.csv')).toBe('C:/path/to/file.csv');
        });

        it('should convert Unix file URI to path', () => {
            // file:///path/to/file.csv -> path/to/file.csv (strips file:///)
            expect(fileUriToPath('file:///path/to/file.csv')).toBe('path/to/file.csv');
        });

        it('should handle quoted file URI', () => {
            expect(fileUriToPath('"file:///C:/path/to/file.csv"')).toBe('C:/path/to/file.csv');
        });

        it('should handle single-quoted file URI', () => {
            // file:///path/to/file.csv -> path/to/file.csv (strips file:///)
            expect(fileUriToPath("'file:///path/to/file.csv'")).toBe('path/to/file.csv');
        });

        it('should handle empty string', () => {
            expect(fileUriToPath('')).toBe('');
        });
    });

    describe('registerImportCommands', () => {
        it('should register all import commands', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            const disposables = registerImportCommands(deps);

            // importClipboard, importDataAdvanced, importData, importWithPicker, snowflake stage import/export, smartPaste
            // Plus 1 paste detection listener = 8 disposables
            expect(disposables).toHaveLength(8);
            expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(7);
        });

        it('should register netezza.importClipboard command', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.importClipboard',
                expect.any(Function),
            );
        });

        it('should register netezza.importData command', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.importData', expect.any(Function));
        });

        it('should register netezza.importDataAdvanced command', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.importDataAdvanced',
                expect.any(Function),
            );
        });

        it('should register netezza.smartPaste command', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.smartPaste', expect.any(Function));
        });

        it('should return disposables for cleanup', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            const disposables = registerImportCommands(deps);

            disposables.forEach((d) => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('generateAutoTableName', () => {
        it('should build auto table name from query result', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                data: [{ CURRENT_CATALOG: 'DB1', CURRENT_SCHEMA: 'SC1' }],
            });
            (queryResultToRows as jest.Mock).mockReturnValue([{ CURRENT_CATALOG: 'DB1', CURRENT_SCHEMA: 'SC1' }]);

            const result = await generateAutoTableName(mockContext, 'conn1', mockConnectionManager);
            expect(runQueryRaw).toHaveBeenCalled();
            expect(result).toMatch(/^DB1\.SC1\.IMPORT_\d{8}_\d{4}$/);
        });

        it('should build lowercase auto table name for postgresql', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                data: [{ CURRENT_CATALOG: 'appdb', CURRENT_SCHEMA: 'public' }],
            });
            (queryResultToRows as jest.Mock).mockReturnValue([{ CURRENT_CATALOG: 'appdb', CURRENT_SCHEMA: 'public' }]);

            const result = await generateAutoTableName(mockContext, 'conn1', mockConnectionManager, 'postgresql');

            expect(result).toMatch(/^appdb\.public\.import_\d{8}_\d{4}$/);
        });

        it('should return null and surface error on query failure', async () => {
            (runQueryRaw as jest.Mock).mockRejectedValue(new Error('cannot query'));

            const result = await generateAutoTableName(mockContext, 'conn1', mockConnectionManager);
            expect(result).toBeNull();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Error getting current database/schema'),
            );
        });

        it('should use DB2 context query when dbType is db2', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                data: [{ CURRENT_CATALOG: 'TESTDB', CURRENT_SCHEMA: 'DB2INST1' }],
            });
            (queryResultToRows as jest.Mock).mockReturnValue([
                { CURRENT_CATALOG: 'TESTDB', CURRENT_SCHEMA: 'DB2INST1' },
            ]);

            await generateAutoTableName(mockContext, 'conn1', mockConnectionManager, 'db2');

            const queryUsed = (runQueryRaw as jest.Mock).mock.calls[0][1];
            expect(queryUsed).toContain('CURRENT SERVER AS CURRENT_CATALOG');
            expect(queryUsed).toContain('CURRENT SCHEMA AS CURRENT_SCHEMA');
        });

        it('should pass documentUri to runQueryRaw for tab database context', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                data: [{ CURRENT_CATALOG: 'RAW', CURRENT_SCHEMA: 'ADMIN' }],
            });
            (queryResultToRows as jest.Mock).mockReturnValue([{ CURRENT_CATALOG: 'RAW', CURRENT_SCHEMA: 'ADMIN' }]);

            await generateAutoTableName(
                mockContext,
                'conn1',
                mockConnectionManager,
                'netezza',
                'file:///active.sql',
            );

            expect(runQueryRaw).toHaveBeenCalledWith(
                mockContext,
                'SELECT CURRENT_CATALOG, CURRENT_SCHEMA',
                true,
                mockConnectionManager,
                'conn1',
                'file:///active.sql',
            );
        });
    });

    describe('importClipboard command handler', () => {
        it('should show error when no connection configured', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: {
                    ...mockConnectionManager,
                    getConnection: jest.fn().mockResolvedValue(null),
                    getConnectionDetailsForImport: jest.fn().mockResolvedValue(undefined),
                },
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Connection not configured'),
            );
        });

        it('should import clipboard data and allow copying table name', async () => {
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Copy Table Name');
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();
            expect(importClipboardDataToNetezza).toHaveBeenCalledWith(
                'admin.target_table',
                expect.any(Object),
                expect.anything(),
                {},
                expect.any(Function),
            );
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('admin.target_table');
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.refreshSchema');
        });

        it('should route clipboard import to DB2 importer for db2 connections', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'db2-connection',
                    host: 'localhost',
                    port: 50000,
                    database: 'TESTDB',
                    user: 'db2inst1',
                    dbType: 'db2',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();
            expect(importClipboardDataToDb2).toHaveBeenCalledWith(
                'admin.target_table',
                expect.objectContaining({ dbType: 'db2' }),
                expect.anything(),
                {},
                expect.any(Function),
            );
            expect(importClipboardDataToNetezza).not.toHaveBeenCalled();
        });

        it('should route clipboard import to PostgreSQL importer for postgresql connections', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'postgres-connection',
                    host: 'localhost',
                    port: 5432,
                    database: 'warehouse',
                    user: 'postgres',
                    dbType: 'postgresql',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();
            expect(importClipboardDataToPostgreSql).toHaveBeenCalledWith(
                'admin.target_table',
                expect.objectContaining({ dbType: 'postgresql' }),
                expect.anything(),
                {},
                expect.any(Function),
            );
            expect(importClipboardDataToDb2).not.toHaveBeenCalled();
            expect(importClipboardDataToNetezza).not.toHaveBeenCalled();
        });

        it('should auto-generate table name when input is empty', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('');
            (runQueryRaw as jest.Mock).mockResolvedValue({ data: [{}] });
            (queryResultToRows as jest.Mock).mockReturnValue([{ CURRENT_CATALOG: 'SYSTEM', CURRENT_SCHEMA: 'ADMIN' }]);
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();
            expect(importClipboardDataToNetezza).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Auto-generated'),
            );
        });

        it('should validate table name input', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let validateInput: any;
            (vscode.window.showInputBox as jest.Mock).mockImplementationOnce((options) => {
                validateInput = options.validateInput;
                return Promise.resolve(undefined); // Abort command
            });
            await handler();

            expect(validateInput).toBeDefined();
            expect(validateInput(undefined)).toBeNull();
            expect(validateInput('   ')).toBeNull();
            expect(validateInput('valid_table')).toBeNull();
            expect(validateInput('db.schema.table')).toBeNull();
            expect(validateInput('db..table')).toBe(
                'Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.',
            );
        });

        it('should log progress and handle import failure', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('target_table');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'TEXT',
            });

            (importClipboardDataToNetezza as jest.Mock).mockImplementationOnce(
                async (_table, _conn, _fmt, _opts, progressCb) => {
                    progressCb('Step 1', 10, true);
                    progressCb('Step 1', 10, true); // Same message shouldn't log twice
                    progressCb('Step 2', 40, false); // logToOutput false
                    return { success: false, message: 'Import failed horribly' };
                },
            );

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importClipboard',
            )?.[1];

            await handler();

            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('[Clipboard Import] Step 1');
            expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith('[Clipboard Import] Step 2'); // false
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Import failed horribly'),
            );
        });
    });

    describe('importData command handler', () => {
        it('should show error when no connection configured', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: {
                    ...mockConnectionManager,
                    getConnection: jest.fn().mockResolvedValue(null),
                    getConnectionDetailsForImport: jest.fn().mockResolvedValue(undefined),
                },
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Connection not configured'),
            );
        });

        it('should open the advanced import wizard command directly', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('target_table');
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importDataAdvanced',
            )?.[1];

            await handler('D:\\direct\\file.csv');

            expect(ImportWizardView.createOrShow).toHaveBeenCalledWith(
                mockContext,
                mockContext.extensionUri,
                mockConnectionManager,
                mockMetadataCache,
                expect.any(Object),
                expect.objectContaining({
                    filePath: 'D:\\direct\\file.csv',
                    targetTable: 'target_table',
                    connectionName: 'test-connection',
                }),
            );
            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should open the advanced import wizard when selected from import mode picker', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: 'Advanced Import Wizard',
                value: 'advanced',
            });

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler('D:\\direct\\file.csv');

            expect(ImportWizardView.createOrShow).toHaveBeenCalledWith(
                mockContext,
                mockContext.extensionUri,
                mockConnectionManager,
                mockMetadataCache,
                expect.any(Object),
                expect.objectContaining({
                    filePath: 'D:\\direct\\file.csv',
                    targetTable: 'admin.target_table',
                }),
            );
            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should import selected file and copy table name', async () => {
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Copy Table Name');
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler();
            expect(importDataToNetezza).toHaveBeenCalledWith(
                'D:\\data\\input.csv',
                'admin.target_table',
                expect.any(Object),
                expect.any(Function),
                undefined,
                undefined,
            );
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('admin.target_table');
        });

        it('should use tab effective database for import connection details', async () => {
            (vscode.window.activeTextEditor as unknown) = {
                document: { uri: { toString: () => 'file:///active.sql' } },
            };
            mockConnectionManager.getEffectiveDatabase.mockResolvedValue('RAW_TAB_DB');

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler('D:\\direct\\file.csv');

            expect(mockConnectionManager.getConnectionDetailsForImport).toHaveBeenCalledWith(
                'file:///active.sql',
                'test-connection',
            );
            expect(importDataToNetezza).toHaveBeenCalledWith(
                'D:\\direct\\file.csv',
                'admin.target_table',
                expect.objectContaining({ database: 'RAW_TAB_DB' }),
                expect.any(Function),
                undefined,
                undefined,
            );

            (vscode.window.activeTextEditor as unknown) = undefined;
        });

        it('should route file import to DB2 importer for db2 connections', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'db2-connection',
                    host: 'localhost',
                    port: 50000,
                    database: 'TESTDB',
                    user: 'db2inst1',
                    dbType: 'db2',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler('D:\\direct\\file.csv');
            expect(importDataToDb2).toHaveBeenCalledWith(
                'D:\\direct\\file.csv',
                'admin.target_table',
                expect.objectContaining({ dbType: 'db2' }),
                expect.any(Function),
                undefined,
                undefined,
            );
            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should route file import to PostgreSQL importer for postgresql connections', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'postgres-connection',
                    host: 'localhost',
                    port: 5432,
                    database: 'warehouse',
                    user: 'postgres',
                    dbType: 'postgresql',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler();
            expect(importDataToPostgreSql).toHaveBeenCalledWith(
                'D:\\data\\input.csv',
                'admin.target_table',
                expect.objectContaining({ dbType: 'postgresql' }),
                expect.any(Function),
                undefined,
                undefined,
            );
            expect(importDataToDb2).not.toHaveBeenCalled();
            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should use provided path argument when file exists', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler('D:\\direct\\file.csv');
            expect(importDataToNetezza).toHaveBeenCalledWith(
                'D:\\direct\\file.csv',
                'admin.target_table',
                expect.any(Object),
                expect.any(Function),
                undefined,
                undefined,
            );
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.refreshSchema');
        });

        it('should return when form import is canceled during column selection', async () => {
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({
                    label: 'Form Import',
                    value: 'form',
                })
                .mockResolvedValueOnce(undefined);
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler();
            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should pass form import options with selected columns and forced types', async () => {
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({
                    label: 'Form Import',
                    value: 'form',
                })
                .mockResolvedValueOnce([
                    {
                        label: 'ID',
                        columnIndex: 0,
                        inferredType: 'BIGINT',
                    },
                    {
                        label: 'AMOUNT',
                        columnIndex: 1,
                        inferredType: 'NUMERIC(16,2)',
                    },
                ])
                .mockResolvedValueOnce([
                    {
                        label: 'AMOUNT',
                        columnIndex: 1,
                        inferredType: 'NUMERIC(16,2)',
                    },
                ]);
            (vscode.window.showInputBox as jest.Mock)
                .mockResolvedValueOnce('admin.target_table')
                .mockResolvedValueOnce('NUMERIC(20,4)');

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            await handler('D:\\direct\\file.csv');

            expect(importDataToNetezza).toHaveBeenCalledWith(
                'D:\\direct\\file.csv',
                'admin.target_table',
                expect.any(Object),
                expect.any(Function),
                undefined,
                {
                    selectedColumnIndexes: [0, 1],
                    forcedColumnTypes: {
                        1: 'NUMERIC(20,4)',
                    },
                },
            );
        });

        it('should validate table name input', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let validateInput: any;
            (vscode.window.showInputBox as jest.Mock).mockImplementationOnce((options) => {
                validateInput = options.validateInput;
                return Promise.resolve(undefined); // Abort command
            });
            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            await handler('D:\\test.csv');

            expect(validateInput).toBeDefined();
            expect(validateInput(undefined)).toBeNull();
            expect(validateInput('db..table')).toBe(
                'Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.',
            );
        });

        it('should tailor target table guidance for MySQL imports', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'test-connection',
                    host: 'localhost',
                    port: 3306,
                    database: 'analytics',
                    username: 'user',
                    dbType: 'mysql',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let inputOptions: any;
            (vscode.window.showInputBox as jest.Mock).mockImplementationOnce((options) => {
                inputOptions = options;
                return Promise.resolve(undefined);
            });
            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            await handler('D:\\test.csv');

            expect(inputOptions.prompt).toContain('MySQL import');
            expect(inputOptions.placeHolder).toBe('TABLE or DATABASE.TABLE');
            expect(inputOptions.validateInput('analytics.orders')).toBeNull();
            expect(inputOptions.validateInput('db.schema.orders')).toBe(
                'Three-part target names are not supported for MySQL. Use TABLE or DATABASE.TABLE.',
            );
        });

        it('should surface active-database mismatch guidance for PostgreSQL imports', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: createImportConnectionManager({
                    name: 'test-connection',
                    host: 'localhost',
                    port: 5432,
                    database: 'warehouse',
                    username: 'postgres',
                    dbType: 'postgresql',
                }),
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let inputOptions: any;
            (vscode.window.showInputBox as jest.Mock).mockImplementationOnce((options) => {
                inputOptions = options;
                return Promise.resolve(undefined);
            });
            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            await handler('D:\\test.csv');

            expect(inputOptions.placeHolder).toBe('TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE');
            expect(inputOptions.validateInput('warehouse.public.orders')).toBeNull();
            expect(inputOptions.validateInput('other.public.orders')).toBe(
                'PostgreSQL import runs against active database "warehouse". Provided database "other" does not match the active connection.',
            );
        });

        it('should handle vscode.Uri argument', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            const uri = vscode.Uri.file('D:\\uri\\file.csv');
            await handler(uri);

            expect(importDataToNetezza).toHaveBeenCalledWith(
                uri.fsPath,
                'admin.target_table',
                expect.any(Object),
                expect.any(Function),
                undefined,
                undefined,
            );
        });

        it('should abort if auto-generating name fails', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('');
            (runQueryRaw as jest.Mock).mockResolvedValue(null); // Failure
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            await handler('D:\\test.csv');

            expect(importDataToNetezza).not.toHaveBeenCalled();
        });

        it('should log progress and handle import failure', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('target_table');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: {},
            });

            (importDataToNetezza as jest.Mock).mockImplementationOnce(async (_src, _table, _conn, progressCb) => {
                progressCb('Reading file', 20, true);
                progressCb('Reading file', 20, true);
                progressCb('Reading stealthy', 30, false);
                return { success: false, message: 'Data import failed' };
            });

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importData',
            )?.[1];

            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            await handler('D:\\test.csv');

            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('[Import] Reading file');
            expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith('[Import] Reading stealthy');
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Data import failed'));
        });
    });

    describe('smartPaste command handler', () => {
        it('should return early when no active editor', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };

            registerImportCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            // Should not throw and should exit early
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });

        it('should detect file path and trigger import command', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('D:\\data\\source.csv');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'importFile',
            });
            const edit = jest.fn(async () => undefined);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importData', 'D:\\data\\source.csv');
            expect(edit).not.toHaveBeenCalled();
        });

        it('should detect tabular data and trigger clipboard import', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a\tb\n1\t2');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: false },
                edit,
                document: { languageId: 'sql' },
            };
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should paste as text by default', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('plain text');
            const replace = jest.fn();
            const edit = jest.fn(async (callback: (builder: { replace: jest.Mock }) => void) => callback({ replace }));
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(replace).toHaveBeenCalled();
        });

        it('should show error if detected file path does not exist', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('D:\\data\\nonexistent.csv');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'importFile',
            });
            (require('fs').existsSync as jest.Mock).mockReturnValue(false); // does not exist

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                document: { languageId: 'sql' },
            };

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('File not found:'));
        });

        it('should catch error in smart paste', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockRejectedValue(new Error('Clipboard error'));
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                document: { languageId: 'sql' },
            };

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Error during paste: Clipboard error'),
            );
        });

        it('should not detect tabbed data if empty string', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('   ');
            const replace = jest.fn();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const edit = jest.fn(async (cb: any) => cb({ replace }));
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                document: { languageId: 'sql' },
                edit,
            };

            await handler();

            expect(edit).toHaveBeenCalled();
        });

        it('should not detect tabbed data if it is a file path', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('C:\\test.csv');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'paste',
            });
            const replace = jest.fn();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const edit = jest.fn(async (cb: any) => cb({ replace }));
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                document: { languageId: 'sql' },
                edit,
            };

            await handler();
            expect(edit).toHaveBeenCalled();
        });

        it('should detect delimiter separated data and trigger import', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('col1,col2\nval1,val2'); // comma separated
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                selection: { isEmpty: true },
                document: { languageId: 'sql' },
            };

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });
    });

    describe('registerPasteDetection', () => {
        it('should ignore non-sql documents', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const onChange = (vscode.workspace.onDidChangeTextDocument as jest.Mock).mock.calls[0][0];

            onChange({ document: { languageId: 'txt' }, contentChanges: [{}] }); // Should just return
            expect(require('fs').existsSync).not.toHaveBeenCalled();
        });

        it('should detect pasted file path and trigger import command if file exists', async () => {
            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'importFile',
            });
            const deleteMock = jest.fn();
            const activeEditor = {
                document: { languageId: 'sql' },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                edit: jest.fn(async (cb: any) => cb({ delete: deleteMock })),
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = activeEditor;

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const onChange = (vscode.workspace.onDidChangeTextDocument as jest.Mock).mock.calls[0][0];

            const startPos = { translate: jest.fn().mockReturnValue('endPos') };
            await onChange({
                document: activeEditor.document,
                contentChanges: [{ text: 'C:\\file.csv', rangeLength: 0, range: { start: startPos } }],
            });

            expect(deleteMock).toHaveBeenCalled();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importData', 'C:\\file.csv');
        });

        it('should handle import error during paste detection', async () => {
            (require('fs').existsSync as jest.Mock).mockReturnValue(true);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'importFile',
            });
            (vscode.commands.executeCommand as jest.Mock).mockRejectedValueOnce(new Error('Paste import failed'));
            const activeEditor = {
                document: { languageId: 'sql' },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                edit: jest.fn(async (cb: any) => cb({ delete: jest.fn() })),
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = activeEditor;

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);

            // Need to mock Date.now to pass the debounce check
            const originalNow = Date.now;
            global.Date.now = jest.fn(() => 1000); // return 1000 dynamically

            const onChange = (vscode.workspace.onDidChangeTextDocument as jest.Mock).mock.calls[0][0];

            const startPos = { translate: jest.fn().mockReturnValue('endPos') };
            await onChange({
                document: activeEditor.document,
                contentChanges: [{ text: 'C:\\file.csv', rangeLength: 0, range: { start: startPos } }],
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Paste import failed'));
            global.Date.now = originalNow;
        });
    });

    // -------------------------------------------------------------------------
    // Additional detectTabbedData edge cases (via smartPaste)
    // -------------------------------------------------------------------------

    describe('importWithPicker command handler', () => {
        it('should register netezza.importWithPicker command', () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.importWithPicker',
                expect.any(Function),
            );
        });

        it('should route clipboard source directly to importClipboard', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            // First quickpick: source = clipboard
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(clippy) From Clipboard',
                value: 'clipboard',
            });

            await handler();

            // Should only show one quickpick (source), not the mode quickpick
            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should not show mode quickpick when clipboard is selected', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                value: 'clipboard',
            });

            await handler();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
            expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should show mode quickpick for file source and route to simple import', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            // First quickpick: source = file
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ value: 'file' })
                .mockResolvedValueOnce({ value: 'simple' });

            await handler();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.importData',
                { mode: 'simple' },
            );
        });

        it('should show mode quickpick for file source and route to advanced import', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ value: 'file' })
                .mockResolvedValueOnce({ value: 'advanced' });

            await handler();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importDataAdvanced');
        });

        it('should return early when source selection is cancelled', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

            await handler();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it('should return early when mode selection is cancelled for file source', async () => {
            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.importWithPicker',
            )?.[1];

            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ value: 'file' })
                .mockResolvedValueOnce(undefined);

            await handler();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });
    });

    describe('detectTabbedData edge cases', () => {
        it('should detect pipe-separated data', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a|b|c\n1|2|3');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should detect semicolon-separated data', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a;b;c\n1;2;3');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should not detect single-line content as tabular data', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('single line text');
            const replace = jest.fn();
            const edit = jest.fn(async (cb: (builder: { replace: jest.Mock }) => void) => cb({ replace }));
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            // Should paste as text since not detected as tabular
            expect(replace).toHaveBeenCalled();
        });

        it('should detect tabular data with many columns', async () => {
            const headers = Array.from({ length: 20 }, (_, i) => `col${i}`).join('\t');
            const values = Array.from({ length: 20 }, (_, i) => `val${i}`).join('\t');
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(`${headers}\n${values}`);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should detect tabular data with mixed delimiters (tabs preferred)', async () => {
            // Content with both tabs and commas - tabs should win
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a,b\tc\n1,2\t3');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should handle user choosing paste as text for tabular data', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a\tb\n1\t2');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'paste',
            });
            const replace = jest.fn();
            const edit = jest.fn(async (cb: (builder: { replace: jest.Mock }) => void) => cb({ replace }));
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(replace).toHaveBeenCalled();
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should detect tabular data with Windows line endings', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a\tb\r\n1\t2');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });

        it('should handle newline at end of tabular data', async () => {
            (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a\tb\n1\t2\n');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                value: 'import',
            });
            const edit = jest.fn(async () => undefined);
            (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
                selection: { isEmpty: true },
                edit,
                document: { languageId: 'sql' },
            };

            const deps: ImportCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                metadataCache: mockMetadataCache,
                outputChannel: mockOutputChannel,
            };
            registerImportCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                (call) => call[0] === 'netezza.smartPaste',
            )?.[1];

            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.importClipboard');
        });
    });
});
