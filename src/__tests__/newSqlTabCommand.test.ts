import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import {
    NEW_SQL_TAB_WITH_CONTEXT_COMMAND,
    registerNewSqlTabCommand,
} from '../commands/newSqlTabCommand';

jest.mock('vscode', () => ({
    commands: {
        executeCommand: jest.fn(),
        registerCommand: jest.fn(),
    },
    languages: {
        setTextDocumentLanguage: jest.fn(),
    },
    window: {
        activeTextEditor: undefined,
    },
}));

interface MockDocument {
    languageId: string;
    uri: {
        scheme: string;
        toString: () => string;
    };
}

function createDocument(uri: string, languageId: string): MockDocument {
    return {
        languageId,
        uri: {
            scheme: uri.slice(0, uri.indexOf(':')),
            toString: () => uri,
        },
    };
}

describe('new SQL tab command', () => {
    let registeredHandler: (() => Promise<void>) | undefined;
    let connectionManager: jest.Mocked<Pick<
        ConnectionManager,
        | 'getConnectionForExecution'
        | 'getDocumentDatabase'
        | 'setDocumentConnection'
        | 'setDocumentDatabase'
    >>;

    beforeEach(() => {
        jest.clearAllMocks();
        registeredHandler = undefined;
        (vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined;
        (vscode.commands.registerCommand as jest.Mock).mockImplementation(
            (_command: string, handler: () => Promise<void>) => {
                registeredHandler = handler;
                return { dispose: jest.fn() };
            },
        );
        connectionManager = {
            getConnectionForExecution: jest.fn(),
            getDocumentDatabase: jest.fn(),
            setDocumentConnection: jest.fn().mockResolvedValue(undefined),
            setDocumentDatabase: jest.fn().mockResolvedValue(undefined),
        };
    });

    function register(): () => Promise<void> {
        registerNewSqlTabCommand(connectionManager as unknown as ConnectionManager);
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            NEW_SQL_TAB_WITH_CONTEXT_COMMAND,
            expect.any(Function),
        );
        expect(registeredHandler).toBeDefined();
        return registeredHandler as () => Promise<void>;
    }

    it('copies the active SQL tab connection and database after setting the target language', async () => {
        const sourceDocument = createDocument('file:///workspace/source.sql', 'sql');
        const plainTarget = createDocument('untitled:Untitled-2', 'plaintext');
        const sqlTarget = createDocument('untitled:Untitled-2', 'sql');
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: sourceDocument,
        };
        connectionManager.getConnectionForExecution.mockReturnValue('REPORTING');
        connectionManager.getDocumentDatabase.mockReturnValue('ANALYTICS');
        (vscode.commands.executeCommand as jest.Mock).mockImplementation(async (command: string) => {
            expect(command).toBe('workbench.action.files.newUntitledFile');
            (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
                document: plainTarget,
            };
        });
        (vscode.languages.setTextDocumentLanguage as jest.Mock).mockResolvedValue(sqlTarget);

        await register()();

        expect(connectionManager.getConnectionForExecution).toHaveBeenCalledWith(
            'file:///workspace/source.sql',
        );
        expect(connectionManager.getDocumentDatabase).toHaveBeenCalledWith(
            'file:///workspace/source.sql',
        );
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(plainTarget, 'sql');
        expect(connectionManager.setDocumentConnection).toHaveBeenCalledWith(
            'untitled:Untitled-2',
            'REPORTING',
        );
        expect(connectionManager.setDocumentDatabase).toHaveBeenCalledWith(
            'untitled:Untitled-2',
            'ANALYTICS',
        );
        expect(
            (vscode.languages.setTextDocumentLanguage as jest.Mock).mock.invocationCallOrder[0],
        ).toBeLessThan(connectionManager.setDocumentConnection.mock.invocationCallOrder[0]);
    });

    it('copies a global fallback connection without inventing a database override', async () => {
        const sourceDocument = createDocument('untitled:Untitled-1', 'mssql');
        const targetDocument = createDocument('untitled:Untitled-2', 'mssql');
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: sourceDocument,
        };
        connectionManager.getConnectionForExecution.mockReturnValue('MSSQL DEV');
        connectionManager.getDocumentDatabase.mockReturnValue(undefined);
        (vscode.commands.executeCommand as jest.Mock).mockImplementation(async () => {
            (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
                document: targetDocument,
            };
        });

        await register()();

        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        expect(connectionManager.setDocumentConnection).toHaveBeenCalledWith(
            'untitled:Untitled-2',
            'MSSQL DEV',
        );
        expect(connectionManager.setDocumentDatabase).not.toHaveBeenCalled();
    });

    it('delegates to the standard new-file command outside a SQL editor', async () => {
        const sourceDocument = createDocument('file:///workspace/readme.md', 'markdown');
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: sourceDocument,
        };

        await register()();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.files.newUntitledFile',
        );
        expect(connectionManager.getConnectionForExecution).not.toHaveBeenCalled();
        expect(connectionManager.setDocumentConnection).not.toHaveBeenCalled();
    });
});
