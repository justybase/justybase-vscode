import * as vscode from 'vscode';
import { registerCatalogDdlCommands } from '../commands/schema/catalogDdlCommands';
import type { ConnectionManager } from '../core/connectionManager';

jest.mock('../core/extensionDocumentParseSession', () => ({
    resolveExtensionSqlRenameSymbol: jest.fn(() => undefined),
}));

describe('catalogDdlCommands', () => {
    const executeCommand = jest.fn();
    const openTextDocument = jest.fn();
    const showTextDocument = jest.fn();
    const setTextDocumentLanguage = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.Uri as unknown as { from: jest.Mock }).from = jest.fn((components: {
            scheme: string;
            path: string;
            query: string;
        }) => ({
            scheme: components.scheme,
            path: components.path,
            query: components.query,
            toString: () => `${components.scheme}:${components.path}?${components.query}`,
        }));
        (vscode.commands.executeCommand as jest.Mock) = executeCommand;
        (vscode.workspace.openTextDocument as jest.Mock) = openTextDocument;
        (vscode.window.showTextDocument as jest.Mock) = showTextDocument;
        (vscode.languages.setTextDocumentLanguage as jest.Mock) = setTextDocumentLanguage;

        openTextDocument.mockResolvedValue({
            uri: { scheme: 'netezza-catalog', query: 'kind=table&name=DIMACCOUNT' },
            languageId: 'plaintext',
        });
        setTextDocumentLanguage.mockResolvedValue(undefined);
        showTextDocument.mockResolvedValue(undefined);
    });

    function getHandler(): () => Promise<void> {
        const registerCommand = vscode.commands.registerCommand as jest.Mock;
        registerCatalogDdlCommands({
            connectionManager: {
                getExecutionDatabaseKind: () => 'netezza',
                getDocumentDatabase: () => 'JUST_DATA',
                getEffectiveSchema: async () => 'ADMIN',
            } as unknown as ConnectionManager,
        });
        return registerCommand.mock.calls.find(
            (call: unknown[]) => call[0] === 'netezza.goToCatalogDdl',
        )?.[1];
    }

    it('opens catalog DDL with SQL language on F12 for qualified table', async () => {
        const handler = getHandler();
        const sql = 'SELECT * FROM JUST_DATA..DIMACCOUNT A';
        const offset = sql.indexOf('DIMACCOUNT');

        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = {
            document: {
                languageId: 'sql',
                uri: { toString: () => 'file:///query.sql' },
                getText: () => sql,
                offsetAt: () => offset,
                positionAt: (value: number) => new vscode.Position(0, value),
            },
            selection: {
                active: new vscode.Position(0, offset),
            },
        } as unknown as vscode.TextEditor;

        await handler();

        expect(openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: 'netezza-catalog',
                path: '/ddl',
            }),
        );
        expect(setTextDocumentLanguage).toHaveBeenCalledWith(
            expect.anything(),
            'sql',
        );
        expect(showTextDocument).toHaveBeenCalled();
        expect(executeCommand).not.toHaveBeenCalledWith('editor.action.revealDefinition');
    });
});
