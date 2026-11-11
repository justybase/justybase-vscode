import * as vscode from 'vscode';
import { activateExplorerViews } from '../activation/activateExplorerViews';
import { SnippetsView } from '../views/snippetsView';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import type { ResultPanelView } from '../views/resultPanelView';

jest.mock('../views/resultPanelView', () => ({
    ResultPanelView: class {
        static readonly viewType = 'netezza.results';
    }
}));

jest.mock('../providers/schemaSearchProvider', () => ({
    SchemaSearchProvider: class {
        static readonly viewType = 'netezza.search';
    }
}));

jest.mock('../providers/fileSearchProvider', () => ({
    FileSearchProvider: class {
        static readonly viewType = 'netezza.fileSearch';
    }
}));

jest.mock('../views/queryHistoryView', () => ({
    QueryHistoryView: class {
        static readonly viewType = 'netezza.queryHistory';
    }
}));

jest.mock('../views/joinKnowledgeManagerView', () => ({
    JoinKnowledgeManagerView: class {
        openInEditor = jest.fn();
    }
}));

jest.mock('../editors/filePreviewEditor', () => ({
    FilePreviewEditor: class {
        static readonly viewType = 'netezza.filePreview';
    }
}));

describe('activateExplorerViews', () => {
    it('registers the snippets webview and its commands', () => {
        jest.clearAllMocks();

        const extensionUri = {
            fsPath: 'D:\\ext',
            toString: () => 'file:///D:/ext'
        } as vscode.Uri;
        const context = {
            extensionUri,
            subscriptions: [],
            globalState: {}
        } as unknown as vscode.ExtensionContext;
        const connectionManager = {} as ConnectionManager;
        const metadataCache = {} as MetadataCache;
        const resultPanelProvider = {} as ResultPanelView;

        const openNewSnippet = jest
            .spyOn(SnippetsView.prototype, 'openNewSnippet')
            .mockResolvedValue(undefined);
        const openFormWithCurrentSql = jest
            .spyOn(SnippetsView.prototype, 'openFormWithCurrentSql')
            .mockResolvedValue(undefined);

        const result = activateExplorerViews(
            context,
            connectionManager,
            metadataCache,
            resultPanelProvider
        );

        expect(result.snippetsProvider).toBeInstanceOf(SnippetsView);
        expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
            'netezza.snippets',
            result.snippetsProvider
        );

        const registerCommand = vscode.commands.registerCommand as jest.Mock;
        const newSnippetCommand = registerCommand.mock.calls.find(
            ([commandId]) => commandId === 'netezza.snippets.new'
        );
        const saveCurrentCommand = registerCommand.mock.calls.find(
            ([commandId]) => commandId === 'netezza.snippets.saveCurrentSql'
        );

        expect(newSnippetCommand).toBeDefined();
        expect(saveCurrentCommand).toBeDefined();

        newSnippetCommand![1]();
        saveCurrentCommand![1]();

        expect(openNewSnippet).toHaveBeenCalledTimes(1);
        expect(openFormWithCurrentSql).toHaveBeenCalledTimes(1);

        openNewSnippet.mockRestore();
        openFormWithCurrentSql.mockRestore();
    });
});
