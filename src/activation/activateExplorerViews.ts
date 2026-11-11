import * as vscode from 'vscode';
import * as path from 'path';
import { ResultPanelView } from '../views/resultPanelView';
import { SchemaSearchProvider } from '../providers/schemaSearchProvider';
import { FileSearchProvider } from '../providers/fileSearchProvider';
import { QueryHistoryView } from '../views/queryHistoryView';
import { SnippetsView } from '../views/snippetsView';
import { JoinKnowledgeManagerView } from '../views/joinKnowledgeManagerView';
import { FilePreviewEditor } from '../editors/filePreviewEditor';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { readJoinKnowledgeManagerFocus } from '../contracts/joinKnowledgeManager';

export interface ExplorerViewsActivationResult {
    schemaSearchProvider: SchemaSearchProvider;
    queryHistoryProvider: QueryHistoryView;
    snippetsProvider: SnippetsView;
    fileSearchProvider: FileSearchProvider;
}

export function activateExplorerViews(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    metadataCache: MetadataCache,
    resultPanelProvider: ResultPanelView,
): ExplorerViewsActivationResult {
    const schemaSearchProvider = new SchemaSearchProvider(
        context.extensionUri,
        context,
        metadataCache,
        connectionManager,
    );
    const queryHistoryProvider = new QueryHistoryView(context.extensionUri, context, connectionManager);
    const snippetsProvider = new SnippetsView(context.extensionUri, context);
    const joinKnowledgeProvider = new JoinKnowledgeManagerView(context.extensionUri);
    const fileSearchProvider = new FileSearchProvider(context.extensionUri, context.globalState);

    context.subscriptions.push(
        resultPanelProvider,
        vscode.window.registerWebviewViewProvider(ResultPanelView.viewType, resultPanelProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(SchemaSearchProvider.viewType, schemaSearchProvider),
        vscode.window.registerWebviewViewProvider(QueryHistoryView.viewType, queryHistoryProvider),
        vscode.window.registerWebviewViewProvider(SnippetsView.viewType, snippetsProvider),
        vscode.commands.registerCommand('netezza.snippets.new', () =>
            snippetsProvider.openNewSnippet()
        ),
        vscode.commands.registerCommand('netezza.snippets.saveCurrentSql', () =>
            snippetsProvider.openFormWithCurrentSql()
        ),
        vscode.commands.registerCommand('netezza.openJoinKnowledge', (focus?: unknown) => {
            joinKnowledgeProvider.openInEditor(readJoinKnowledgeManagerFocus(focus));
        }),
        vscode.window.registerWebviewViewProvider(FileSearchProvider.viewType, fileSearchProvider),
        vscode.commands.registerCommand('netezza.fileSearch.focus', () => {
            vscode.commands.executeCommand('workbench.view.extension.netezza-explorer');
            vscode.commands.executeCommand('workbench.view.extension.netezza-explorer');
        }),
        vscode.commands.registerCommand('netezza.fileSearch.run', () => {
            vscode.commands.executeCommand('workbench.view.extension.netezza-explorer');
        }),
        vscode.window.registerCustomEditorProvider(
            FilePreviewEditor.viewType,
            new FilePreviewEditor(context.extensionUri, context, connectionManager),
            // Rows stream into the webview over time; keeping it alive avoids losing the loaded page
            // when the user switches editor tabs and comes back.
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
        vscode.commands.registerCommand('netezza.openInFilePreview', (resource?: vscode.Uri) => {
            const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
            if (!uri) {
                vscode.window.showErrorMessage('No file selected to preview');
                return;
            }
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (!['.tsv', '.tab', '.csv', '.parquet', '.xlsx', '.xlsb', '.nzpreview'].includes(ext)) {
                vscode.window.showWarningMessage(`File preview does not support ${ext} files`);
                return;
            }
            vscode.commands.executeCommand('vscode.openWith', uri, FilePreviewEditor.viewType);
        }),
        vscode.commands.registerCommand('netezza.switchToNativeCsvPreview', (resource?: vscode.Uri) => {
            const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
            if (uri) {
                void vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
    );

    return { schemaSearchProvider, queryHistoryProvider, snippetsProvider, fileSearchProvider };
}
