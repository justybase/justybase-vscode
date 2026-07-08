/**
 * Tests for commands/schema/copyCommands.ts
 */

import * as vscode from 'vscode';
import { registerCopyCommands } from '../commands/schema/copyCommands';
import { SchemaItemData } from '../commands/schema/types';

// Mock vscode module
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() }))
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn(),
        showTextDocument: jest.fn(),
        withProgress: jest.fn()
    },
    workspace: {
        openTextDocument: jest.fn(),
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue)
        }))
    },
    env: {
        clipboard: {
            writeText: jest.fn()
        },
        openExternal: jest.fn()
    },
    Uri: {
        file: jest.fn((path) => ({ fsPath: path }))
    },
    ProgressLocation: {
        Notification: 1
    }
}));

jest.mock('../core/queryRunner', () => ({
    runQuery: jest.fn()
}));

jest.mock('../commands/schema/helpers', () => ({
    getFullName: jest.fn((item: SchemaItemData) => `${item.dbName}.${item.schema}.${item.label}`),
    getItemObjectName: jest.fn((item: SchemaItemData) => item.rawLabel || item.label || ''),
    executeWithProgress: jest.fn((_title: string, task: () => Promise<void>) => task())
}));

import { runQuery } from '../core/queryRunner';
import { getFullName, executeWithProgress } from '../commands/schema/helpers';

describe('commands/schema/copyCommands', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockContext: any;
    let mockConnectionManager: { getConnection: jest.Mock; getActiveConnectionName: jest.Mock };
    let mockMetadataCache: object;
    let mockSchemaProvider: { refresh: jest.Mock };
    let mockSchemaTreeView: object;
    let registeredCommands: Map<string, (...args: unknown[]) => Promise<void> | void>;
    let mockRegisterCommand: jest.Mock;

    beforeEach(() => {
        registeredCommands = new Map();
        mockRegisterCommand = jest.fn((commandId: string, handler: (...args: unknown[]) => Promise<void> | void) => {
            registeredCommands.set(commandId, handler);
            return { dispose: jest.fn() };
        });

        (vscode.commands.registerCommand as jest.Mock) = mockRegisterCommand;

        // Create minimal mock context
        mockContext = {
            subscriptions: [],
            extensionUri: {} as vscode.Uri,
            extensionPath: '/test/extension',
            globalState: {
                get: jest.fn(),
                update: jest.fn(),
                keys: jest.fn(() => []),
                setKeysForSync: jest.fn()
            },
            workspaceState: {
                get: jest.fn(),
                update: jest.fn(),
                keys: jest.fn(() => [])
            },
            secrets: {},
            environmentVariableCollection: {
                getScoped: jest.fn()
            },
            storageUri: undefined,
            storagePath: undefined,
            globalStorageUri: {} as vscode.Uri,
            globalStoragePath: '/test/global-storage',
            logUri: {} as vscode.Uri,
            logPath: '/test/log',
            extensionMode: 3, // vscode.ExtensionMode.Test
            extension: {},
            asAbsolutePath: jest.fn(),
            languageModelAccessInformation: {}
        };

        mockConnectionManager = {
            getConnection: jest.fn(),
            getActiveConnectionName: jest.fn()
        };

        mockMetadataCache = {};

        mockSchemaProvider = {
            refresh: jest.fn()
        };

        mockSchemaTreeView = {};

        jest.clearAllMocks();
    });

    const createDeps = () => ({
        context: mockContext,
        connectionManager: mockConnectionManager as unknown as import('../core/connectionManager').ConnectionManager,
        metadataCache: mockMetadataCache as unknown as import('../metadataCache').MetadataCache,
        schemaProvider: mockSchemaProvider as unknown as import('../providers/schemaProvider').SchemaProvider,
        schemaTreeView: mockSchemaTreeView as unknown as vscode.TreeView<import('../providers/schemaProvider').SchemaItem>
    });

    describe('registerCopyCommands', () => {
        it('should register all copy commands', () => {
            const disposables = registerCopyCommands(createDeps());

            expect(disposables).toHaveLength(4);
            expect(registeredCommands.has('netezza.copySelectAll')).toBe(true);
            expect(registeredCommands.has('netezza.copyDrop')).toBe(true);
            expect(registeredCommands.has('netezza.copyName')).toBe(true);
        });

        it('should return disposables for cleanup', () => {
            const disposables = registerCopyCommands(createDeps());

            disposables.forEach(d => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('netezza.copySelectAll command handler', () => {
        it('should do nothing when item is missing', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            await handler(undefined);

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        });

        it('should do nothing when item is missing label', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            await handler({ dbName: 'testdb', schema: 'testschema' });

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        });

        it('should show quick pick when item is valid', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema'
            };

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await handler(item);

            expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
                [
                    { label: 'Open in Editor', description: 'Open SQL in a new editor', value: 'editor' },
                    { label: 'Copy to Clipboard', description: 'Copy SQL to clipboard', value: 'clipboard' }
                ],
                { placeHolder: 'How would you like to access the SQL?' }
            );
        });

        it('should open in editor when selected', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema'
            };

            const mockDoc = { uri: {} as vscode.Uri };
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(mockDoc);
            (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ value: 'editor' });

            await handler(item);

            const expectedSql = 'SELECT * FROM testdb.testschema.testtable LIMIT 1000;';
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
                content: expectedSql,
                language: 'sql'
            });
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(mockDoc);
        });

        it('should copy to clipboard when selected', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema'
            };

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ value: 'clipboard' });
            (vscode.env.clipboard.writeText as jest.Mock).mockResolvedValue(undefined);
            (vscode.window.showInformationMessage as jest.Mock).mockReturnValue(undefined);

            await handler(item);

            const expectedSql = 'SELECT * FROM testdb.testschema.testtable LIMIT 1000;';
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expectedSql);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied to clipboard');
        });

        it('should do nothing when quick pick is cancelled', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copySelectAll')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema'
            };

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await handler(item);

            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
            expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        });
    });

    describe('netezza.copyDrop command handler', () => {
        it('should do nothing when item is missing', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            await handler(undefined);

            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it('should do nothing when item is missing objType', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            await handler({ label: 'testtable', dbName: 'testdb', schema: 'testschema' });

            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it('should show warning confirmation dialog', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema',
                objType: 'TABLE'
            };

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');

            await handler(item);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'Are you sure you want to delete table "testdb.testschema.testtable"?',
                { modal: true },
                'Yes, delete',
                'Cancel'
            );
        });

        it('should not delete when cancelled', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema',
                objType: 'TABLE'
            };

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');

            await handler(item);

            expect(runQuery).not.toHaveBeenCalled();
        });

        it('should execute drop when confirmed', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema',
                objType: 'TABLE',
                connectionName: 'testconn'
            };

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, delete');
            (runQuery as jest.Mock).mockResolvedValue(undefined);
            (vscode.window.showInformationMessage as jest.Mock).mockReturnValue(undefined);

            await handler(item);

            expect(executeWithProgress).toHaveBeenCalled();
            expect(runQuery).toHaveBeenCalledWith(
                mockContext,
                'DROP TABLE testdb.testschema.testtable;',
                true,
                'testconn',
                mockConnectionManager
            );
            expect(mockSchemaProvider.refresh).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Deleted table: testdb.testschema.testtable'
            );
        });

        it('should show error when drop fails', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema',
                objType: 'VIEW',
                connectionName: 'testconn'
            };

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, delete');
            (runQuery as jest.Mock).mockRejectedValue(new Error('Database error'));
            (vscode.window.showErrorMessage as jest.Mock).mockReturnValue(undefined);

            await handler(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error during deletion: Database error');
        });

        it('should handle non-Error errors', async () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyDrop')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema',
                objType: 'TABLE',
                connectionName: 'testconn'
            };

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, delete');
            (runQuery as jest.Mock).mockRejectedValue('String error');
            (vscode.window.showErrorMessage as jest.Mock).mockReturnValue(undefined);

            await handler(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error during deletion: String error');
        });
    });

    describe('netezza.copyName command handler', () => {
        it('should do nothing when item is missing', () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyName')!;

            handler(undefined);

            expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        });

        it('should do nothing when item is missing required fields', () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyName')!;

            handler({ label: 'testtable' });

            expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        });

        it('should copy full name to clipboard', () => {
            registerCopyCommands(createDeps());
            const handler = registeredCommands.get('netezza.copyName')!;

            const item: SchemaItemData = {
                label: 'testtable',
                dbName: 'testdb',
                schema: 'testschema'
            };

            (vscode.window.showInformationMessage as jest.Mock).mockReturnValue(undefined);

            handler(item);

            expect(getFullName).toHaveBeenCalledWith(item, mockConnectionManager);
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('testdb.testschema.testtable');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied to clipboard');
        });
    });
});
