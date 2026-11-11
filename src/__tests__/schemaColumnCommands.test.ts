/**
 * Column-level schema-tree commands: copy, insert, filter, sort, distinct,
 * profile, and favorite actions.
 */

import * as vscode from 'vscode';
import { registerColumnCommands } from '../commands/schema/columnCommands';
import type { SchemaCommandsDependencies, SchemaItemData } from '../commands/schema/types';

const mockToggleFavorite = jest.fn(async () => true);

jest.mock('vscode', () => {
    class Selection {
        constructor(public readonly anchor: unknown, public readonly active: unknown) {}
    }
    class Range {
        constructor(public readonly start: unknown, public readonly end: unknown) {}
    }
    return {
        commands: {
            registerCommand: jest.fn((_id: string, callback: (...args: unknown[]) => unknown) => {
                return { callback, dispose: jest.fn() };
            }),
        },
        window: {
            activeTextEditor: undefined,
            showErrorMessage: jest.fn(),
            showWarningMessage: jest.fn(),
            showInformationMessage: jest.fn(),
            showInputBox: jest.fn(),
            showTextDocument: jest.fn(),
        },
        workspace: {
            openTextDocument: jest.fn(),
        },
        env: {
            clipboard: {
                writeText: jest.fn(),
            },
        },
        TreeItemCollapsibleState: { None: 0 },
        Selection,
        Range,
    };
});

jest.mock('../providers/schemaProvider', () => ({
    SchemaItem: class {
        public readonly contextValue: string;
        public readonly dbName?: string;
        public readonly objType?: string;
        public readonly schema?: string;
        public readonly connectionName?: string;

        constructor(public readonly label: string, ...args: unknown[]) {
            this.contextValue = args[1] as string;
            this.dbName = args[2] as string | undefined;
            this.objType = args[3] as string | undefined;
            this.schema = args[4] as string | undefined;
            this.connectionName = args[7] as string | undefined;
        }
    },
}));

jest.mock('../core/favoritesManager', () => ({
    FavoritesManager: {
        getInstance: jest.fn(() => ({ toggleFavorite: mockToggleFavorite })),
    },
}));

function createDeps(): SchemaCommandsDependencies {
    return {
        context: {} as vscode.ExtensionContext,
        connectionManager: {
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
            setDocumentConnection: jest.fn(),
            setDocumentDatabase: jest.fn().mockResolvedValue(undefined),
        } as never,
        metadataCache: {} as never,
        schemaProvider: {} as never,
        schemaTreeView: {} as never,
    };
}

function columnItem(overrides: Partial<SchemaItemData> = {}): SchemaItemData {
    return {
        label: 'ORDER_ID',
        rawLabel: 'ORDER_ID',
        dbName: 'SALES',
        schema: 'ADMIN',
        parentName: 'ORDERS',
        objType: 'TABLE',
        connectionName: 'NZ',
        contextValue: 'column',
        dataType: 'INTEGER',
        ...overrides,
    };
}

function registeredHandlers(): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const registerCommand = vscode.commands.registerCommand as jest.Mock;
    for (const call of registerCommand.mock.calls) {
        handlers.set(call[0] as string, call[1] as (...args: unknown[]) => unknown);
    }
    return handlers;
}

describe('schema column commands', () => {
    const originalOpenTextDocument = vscode.workspace.openTextDocument;

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
            uri: { toString: () => 'untitled:column-command' },
        });
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
        (vscode.env.clipboard.writeText as jest.Mock).mockResolvedValue(undefined);
    });

    afterAll(() => {
        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(originalOpenTextDocument);
    });

    it('registers every column action', () => {
        registerColumnCommands(createDeps());
        const handlers = registeredHandlers();

        expect([...handlers.keys()]).toEqual([
            'netezza.copyColumnName',
            'netezza.copyQualifiedColumnName',
            'netezza.addColumnToSelect',
            'netezza.filterColumnByValue',
            'netezza.sortColumnAscending',
            'netezza.sortColumnDescending',
            'netezza.selectDistinctColumn',
            'netezza.profileColumn',
            'netezza.toggleColumnFavorite',
        ]);
    });

    it('copies the bare and qualified column names', async () => {
        const handlers = (registerColumnCommands(createDeps()), registeredHandlers());

        await handlers.get('netezza.copyColumnName')!(columnItem());
        expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('ORDER_ID');

        await handlers.get('netezza.copyQualifiedColumnName')!(columnItem());
        expect(vscode.env.clipboard.writeText).toHaveBeenLastCalledWith('SALES.ADMIN.ORDERS.ORDER_ID');
    });

    it('opens filter, sort, distinct, and profile queries in an editor bound to the column table', async () => {
        const deps = createDeps();
        const handlers = (registerColumnCommands(deps), registeredHandlers());
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue("O'Reilly");

        await handlers.get('netezza.filterColumnByValue')!(columnItem());
        expect(vscode.workspace.openTextDocument).toHaveBeenLastCalledWith({
            content: "SELECT * FROM SALES.ADMIN.ORDERS WHERE ORDER_ID = 'O''Reilly';",
            language: 'sql',
        });
        expect(deps.connectionManager.setDocumentConnection).toHaveBeenCalledWith(
            'untitled:column-command',
            'NZ',
        );
        expect(deps.connectionManager.setDocumentDatabase).toHaveBeenCalledWith(
            'untitled:column-command',
            'SALES',
        );

        await handlers.get('netezza.sortColumnDescending')!(columnItem());
        expect(vscode.workspace.openTextDocument).toHaveBeenLastCalledWith({
            content: 'SELECT * FROM SALES.ADMIN.ORDERS ORDER BY ORDER_ID DESC;',
            language: 'sql',
        });

        await handlers.get('netezza.selectDistinctColumn')!(columnItem());
        expect(vscode.workspace.openTextDocument).toHaveBeenLastCalledWith({
            content: 'SELECT DISTINCT ORDER_ID FROM SALES.ADMIN.ORDERS;',
            language: 'sql',
        });

        await handlers.get('netezza.profileColumn')!(columnItem());
        expect(vscode.workspace.openTextDocument).toHaveBeenLastCalledWith({
            content: expect.stringContaining('AVG(ORDER_ID) AS AVG_VALUE'),
            language: 'sql',
        });
    });

    it('inserts the quoted column name into the active editor', async () => {
        const handlers = (registerColumnCommands(createDeps()), registeredHandlers());
        const insert = jest.fn();
        const active = { line: 0, character: 5, translate: jest.fn(() => ({ line: 0, character: 13 })) };
        const editor = {
            selection: { active },
            edit: jest.fn(async (callback: (builder: { insert: typeof insert }) => void) => {
                callback({ insert });
                return true;
            }),
            revealRange: jest.fn(),
        };
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = editor;

        await handlers.get('netezza.addColumnToSelect')!(columnItem({ label: 'Order Id', rawLabel: 'Order Id' }));

        expect(insert).toHaveBeenCalledWith(active, '"Order Id"');
        expect(editor.revealRange).toHaveBeenCalled();
    });

    it('adds the parent table to favorites instead of the column node', async () => {
        const handlers = (registerColumnCommands(createDeps()), registeredHandlers());

        await handlers.get('netezza.toggleColumnFavorite')!(columnItem());

        expect(mockToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({
            label: 'ORDERS',
            contextValue: 'netezza:TABLE',
            dbName: 'SALES',
            schema: 'ADMIN',
            connectionName: 'NZ',
        }));
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Added ORDERS to Favorites');
    });
});
