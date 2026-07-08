import * as vscode from 'vscode';
import * as path from 'path';
import { ResultPanelView } from '../views/resultPanelView';
import { SchemaSearchProvider } from '../providers/schemaSearchProvider';
import { FileSearchProvider } from '../providers/fileSearchProvider';
import { QueryHistoryView } from '../views/queryHistoryView';
import { FilePreviewEditor } from '../editors/filePreviewEditor';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';

export interface ExplorerViewsActivationResult {
    schemaSearchProvider: SchemaSearchProvider;
    queryHistoryProvider: QueryHistoryView;
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
    const queryHistoryProvider = new QueryHistoryView(context.extensionUri, context);
    const fileSearchProvider = new FileSearchProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ResultPanelView.viewType, resultPanelProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(SchemaSearchProvider.viewType, schemaSearchProvider),
        vscode.window.registerWebviewViewProvider(QueryHistoryView.viewType, queryHistoryProvider),
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
            new FilePreviewEditor(context.extensionUri),
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

    return { schemaSearchProvider, queryHistoryProvider, fileSearchProvider };
}
