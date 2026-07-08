import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import {
    DATABASE_UI_CONTEXT_PREFIX,
    registerDatabaseUiContexts,
    updateDatabaseUiContexts,
    updateSchemaUiContexts
} from '../services/databaseUiContextService';

jest.mock('vscode', () => ({
    commands: {
        executeCommand: jest.fn()
    },
    window: {
        activeTextEditor: undefined,
        onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() }))
    }
}));

describe('databaseUiContextService', () => {
    let mockConnectionManager: {
        resolveConnectionName: jest.Mock;
        getConnectionDatabaseKind: jest.Mock;
        supportsCapability: jest.Mock;
        onDidChangeConnections: jest.Mock;
        onDidChangeActiveConnection: jest.Mock;
        onDidChangeDocumentConnection: jest.Mock;
        onDidChangeDocumentDatabase: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnectionManager = {
            resolveConnectionName: jest.fn().mockReturnValue('conn-a'),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            supportsCapability: jest.fn((capability: string) =>
                capability === 'supportsExplainPlan' || capability === 'supportsTableMaintenance'
            ),
            onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeActiveConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeDocumentConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeDocumentDatabase: jest.fn(() => ({ dispose: jest.fn() }))
        };
    });

    it('updates active connection, database kind and capability context keys', async () => {
        const activeEditor = {
            document: {
                uri: {
                    toString: () => 'file:///query.sql'
                }
            }
        } as unknown as vscode.TextEditor;

        await updateDatabaseUiContexts(
            mockConnectionManager as unknown as ConnectionManager,
            activeEditor
        );

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.active.hasConnection`,
            true
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.active.databaseKind`,
            'netezza'
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.active.capabilities.supportsExplainPlan`,
            true
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.active.capabilities.supportsSessionMonitor`,
            false
        );
    });

    it('updates schema capability context keys from selected schema connection', async () => {
        mockConnectionManager.getConnectionDatabaseKind.mockImplementation((connectionName?: string) =>
            connectionName === 'conn-b' ? 'postgresql' : 'netezza'
        );
        mockConnectionManager.supportsCapability.mockImplementation(
            (capability: string, _documentUri?: string, connectionName?: string) =>
                capability === 'supportsExternalTables' && connectionName === 'conn-b'
        );

        await updateSchemaUiContexts(
            mockConnectionManager as unknown as ConnectionManager,
            { connectionName: 'conn-b' }
        );

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.schema.hasConnection`,
            true
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.schema.databaseKind`,
            'postgresql'
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.schema.capabilities.supportsExternalTables`,
            true
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'setContext',
            `${DATABASE_UI_CONTEXT_PREFIX}.schema.capabilities.supportsExplainPlan`,
            false
        );
    });

    it('registers listeners for active editor, connection changes and schema selection', () => {
        const mockSchemaTreeView = {
            selection: [{ connectionName: 'conn-b' }],
            onDidChangeSelection: jest.fn(() => ({ dispose: jest.fn() }))
        } as unknown as vscode.TreeView<unknown>;

        const disposables = registerDatabaseUiContexts(
            mockConnectionManager as unknown as ConnectionManager,
            mockSchemaTreeView as unknown as vscode.TreeView<import('../providers/schemaProvider').SchemaItem>
        );

        expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalledWith(expect.any(Function));
        expect(mockConnectionManager.onDidChangeConnections).toHaveBeenCalledWith(expect.any(Function));
        expect(mockConnectionManager.onDidChangeActiveConnection).toHaveBeenCalledWith(expect.any(Function));
        expect(mockConnectionManager.onDidChangeDocumentConnection).toHaveBeenCalledWith(expect.any(Function));
        expect(mockConnectionManager.onDidChangeDocumentDatabase).toHaveBeenCalledWith(expect.any(Function));
        expect((mockSchemaTreeView.onDidChangeSelection as jest.Mock)).toHaveBeenCalledWith(expect.any(Function));
        expect(disposables).toHaveLength(6);
    });
});
