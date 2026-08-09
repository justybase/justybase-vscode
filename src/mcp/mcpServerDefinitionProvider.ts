import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../core/connectionManager';
import { connectionDetailsToEnv } from './mcpEnv';
import {
    getConfiguredMcpConnectionName,
    getMcpConnectionSelectionError,
    resolveSelectedMcpConnection
} from './mcpConnection';
import { MCP_SERVER_ID, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcpToolCatalog';

/**
 * Registers the Netezza MCP server with the VS Code MCP client
 * (`vscode.lm.registerMcpServerDefinitionProvider`).
 *
 * Security model — passwords never touch the file system:
 * - `provideMcpServerDefinitions` returns the server definition WITHOUT any
 *   secrets (empty env).
 * - `resolveMcpServerDefinition` is invoked by the editor right before the
 *   server process is started. It loads the explicitly selected connection
 *   (including the password) from the VS Code Secrets API via
 *   ConnectionManager and injects it into the `env` of the spawned child
 *   process.
 */
export class NetezzaMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
    private readonly didChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions: vscode.Event<void> = this.didChange.event;

    private enabled = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly _getSelectedConnectionName: () => string | undefined = getConfiguredMcpConnectionName
    ) {
        this.context.subscriptions.push(
            this.connectionManager.onDidChangeConnections(() => this.didChange.fire())
        );
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getSelectedConnectionName(): string | undefined {
        return this._getSelectedConnectionName();
    }

    getSelectionError(): string | undefined {
        return getMcpConnectionSelectionError(this.connectionManager, this.getSelectedConnectionName());
    }

    hasSelectedNetezzaConnection(): boolean {
        return this.getSelectionError() === undefined;
    }

    /** @deprecated Use hasSelectedNetezzaConnection. */
    hasActiveNetezzaConnection(): boolean {
        return this.hasSelectedNetezzaConnection();
    }

    refresh(): void {
        this.didChange.fire();
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) {
            return;
        }
        this.enabled = enabled;
        this.didChange.fire();
    }

    provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
        if (!this.enabled || !this.hasSelectedNetezzaConnection()) {
            return [];
        }

        return [
            new vscode.McpStdioServerDefinition(
                MCP_SERVER_NAME,
                process.execPath,
                [path.join(this.context.extensionPath, 'dist', 'mcp', 'mcpServer.js')],
                {},
                MCP_SERVER_VERSION
            )
        ];
    }

    async resolveMcpServerDefinition(
        server: vscode.McpStdioServerDefinition
    ): Promise<vscode.McpStdioServerDefinition | undefined> {
        const resolution = await resolveSelectedMcpConnection(
            this.connectionManager,
            this.getSelectedConnectionName()
        );
        if ('error' in resolution) {
            return undefined;
        }

        server.env = connectionDetailsToEnv({
            ...resolution.details,
            name: resolution.details.name ?? resolution.connectionName
        });
        server.version = MCP_SERVER_VERSION;
        return server;
    }
}

export function canRegisterMcpServerDefinitionProvider(): boolean {
    const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: unknown };
    return typeof lm.registerMcpServerDefinitionProvider === 'function';
}

export function registerMcpServerDefinitionProvider(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager
): NetezzaMcpServerDefinitionProvider | undefined {
    if (!canRegisterMcpServerDefinitionProvider()) {
        return undefined;
    }

    const provider = new NetezzaMcpServerDefinitionProvider(context, connectionManager);
    const lm = vscode.lm as typeof vscode.lm & {
        registerMcpServerDefinitionProvider(id: string, provider: vscode.McpServerDefinitionProvider): vscode.Disposable;
    };
    context.subscriptions.push(lm.registerMcpServerDefinitionProvider(`justybase.${MCP_SERVER_ID}`, provider));
    return provider;
}
