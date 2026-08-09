import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { Logger } from '../utils/logger';
import {
    canRegisterMcpServerDefinitionProvider,
    registerMcpServerDefinitionProvider,
    NetezzaMcpServerDefinitionProvider
} from '../mcp/mcpServerDefinitionProvider';
import { McpHttpServerManager } from '../mcp/mcpHttpServerManager';
import { getConfiguredMcpConnectionName } from '../mcp/mcpConnection';
import { SettingsView } from '../views/settingsView';

interface McpRegistrationParams {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    logger: Logger;
}

/**
 * Wires the Netezza MCP server:
 * - MCP server definition provider (stdio mode for Copilot Chat in VS Code),
 * - HTTP mode manager (external MCP clients on the local machine),
 * - MCP configuration and status in the JustyBase Settings view.
 *
 * Registration is safe on older VS Code versions: when the
 * `registerMcpServerDefinitionProvider` API is missing, the provider is not
 * registered and the panel shows a notice instead.
 */
export function registerMcpFeatures(params: McpRegistrationParams): void {
    const { context, connectionManager, logger } = params;

    if (!canRegisterMcpServerDefinitionProvider()) {
        logger.warn('Netezza MCP server: registerMcpServerDefinitionProvider API not available in this VS Code version.');
    }

    const definitionProvider: NetezzaMcpServerDefinitionProvider | undefined =
        registerMcpServerDefinitionProvider(context, connectionManager);

    const httpManager = new McpHttpServerManager(context, connectionManager);
    context.subscriptions.push(httpManager);
    SettingsView.configureMcp({ connectionManager, definitionProvider, httpManager });

    const syncConfiguration = async (forceHttpRestart = false): Promise<void> => {
        const config = getExtensionConfiguration('mcp');
        const enabled = config.get<boolean>('enabled', false) === true;
        const externalEnabled = config.get<boolean>('externalEnabled', false) === true;
        const port = config.get<number>('port', 37210) ?? 37210;
        const selectedConnectionName = getConfiguredMcpConnectionName();

        definitionProvider?.setEnabled(enabled);
        definitionProvider?.refresh();

        const status = httpManager.getStatus();
        if (!externalEnabled) {
            if (status.running) {
                await httpManager.stop();
            }
            return;
        }

        if (status.running && (
            forceHttpRestart
            || status.port !== port
            || status.connectionName !== selectedConnectionName
        )) {
            await httpManager.stop();
        }
        if (!httpManager.getStatus().running) {
            await httpManager.start(port);
        }
    };

    // Configuration changes can arrive back-to-back (the Settings view updates
    // externalEnabled and port separately). Keep stop/start operations strictly
    // ordered because McpHttpServerManager assigns its child only after async
    // connection setup has completed.
    let syncQueue: Promise<void> = Promise.resolve();
    const enqueueSync = (forceHttpRestart = false): Promise<void> => {
        const nextSync = syncQueue.then(
            () => syncConfiguration(forceHttpRestart),
            () => syncConfiguration(forceHttpRestart)
        );
        syncQueue = nextSync.catch(() => undefined);
        return nextSync;
    };

    const syncAndRefreshSettings = (forceHttpRestart = false): void => {
        void enqueueSync(forceHttpRestart)
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`Netezza MCP server: configuration update failed: ${message}`);
            });
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('justybase.mcp')) {
                syncAndRefreshSettings();
            }
        }),
        connectionManager.onDidChangeConnections(() => syncAndRefreshSettings(true))
    );

    void enqueueSync().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza MCP server: HTTP mode could not start: ${message}`);
    });
}
