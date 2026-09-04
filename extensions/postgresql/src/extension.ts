import * as vscode from 'vscode';
import { activateCoreExtension } from '../../../src/api/companionActivation';
import { postgresqlDialect } from './postgresqlDialect';
import { PostgreSqlTunnelManager } from './postgresqlTunnel';
import { registerPostgreSqlTunnelCommands } from './postgresqlTunnelCommands';

let tunnelManager: PostgreSqlTunnelManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(postgresqlDialect);
    tunnelManager = new PostgreSqlTunnelManager(
        context.globalState,
        context.secrets,
        (message, error) => console.warn(`[PostgreSQL tunnel] ${message}`, error ?? ''),
    );
    registerPostgreSqlTunnelCommands(context, tunnelManager);
}

export async function deactivate(): Promise<void> {
    await tunnelManager?.stopAll();
    tunnelManager = undefined;
}
