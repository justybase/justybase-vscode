import * as vscode from 'vscode';
import type {
    ImportWizardInboundMessage,
    ImportWizardOutboundMessage
} from '../contracts/webviews';
import type { ConnectionManager } from '../core/connectionManager';
import { ImportWizardService } from '../import/wizard/ImportWizardService';
import { ImportTargetCatalogService } from '../import/wizard/ImportTargetCatalogService';
import type { ImportWizardSessionOptions } from '../import/wizard/ImportWizardState';
import type { MetadataCache } from '../metadataCache';
import { ImportWizardMessageHandler } from './importWizardMessageHandler';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export class ImportWizardView {
    public static readonly viewType = 'netezza.importWizard';
    private static currentPanel: ImportWizardView | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private messageHandler: ImportWizardMessageHandler;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        metadataCache: MetadataCache,
        service: ImportWizardService,
    ) {
        this.panel = panel;
        this.messageHandler = new ImportWizardMessageHandler({
            service,
            connectionManager,
            catalogService: new ImportTargetCatalogService(
                context,
                connectionManager,
                metadataCache,
            ),
            postMessage: (message: ImportWizardOutboundMessage) => this.panel.webview.postMessage(message),
            onTargetTableChanged: (targetTable) => {
                this.panel.title = `Advanced Import: ${targetTable}`;
            },
        });

        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'dist'),
            ],
        };
        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            async (message: ImportWizardInboundMessage) => this.messageHandler.handleMessage(message),
            null,
            this.disposables,
        );
    }

    public static async createOrShow(
        context: vscode.ExtensionContext,
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        metadataCache: MetadataCache,
        service: ImportWizardService,
        options: ImportWizardSessionOptions,
    ): Promise<ImportWizardView> {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

        if (ImportWizardView.currentPanel) {
            ImportWizardView.currentPanel.panel.reveal(column);
            await ImportWizardView.currentPanel.loadSession(options);
            return ImportWizardView.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ImportWizardView.viewType,
            'Advanced Import Wizard',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'dist'),
            ],
            },
        );

        const view = new ImportWizardView(
            panel,
            extensionUri,
            context,
            connectionManager,
            metadataCache,
            service,
        );
        ImportWizardView.currentPanel = view;
        await view.loadSession(options);
        return view;
    }

    public async loadSession(options: ImportWizardSessionOptions): Promise<void> {
        this.panel.title = `Advanced Import: ${options.targetTable}`;
        await this.messageHandler.initialize(options);
    }

    public dispose(): void {
        if (ImportWizardView.currentPanel === this) {
            ImportWizardView.currentPanel = undefined;
        }

        this.messageHandler.dispose();
        this.panel.dispose();
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'media', 'importWizard.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'importWizard.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Advanced Import Wizard</title>
</head>
<body>
    <div id="app" class="import-wizard-root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
