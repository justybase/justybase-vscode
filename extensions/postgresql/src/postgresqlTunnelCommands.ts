import * as vscode from 'vscode';
import {
    PostgreSqlTunnelManager,
    type PostgreSqlTunnelProfile,
    postgresqlTunnelDefaults,
} from './postgresqlTunnel';

function parsePort(value: string | undefined): number {
    const port = Number(value ?? postgresqlTunnelDefaults.localPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Local port must be an integer between 1 and 65535.');
    }
    return port;
}

async function chooseProfile(manager: PostgreSqlTunnelManager, placeHolder: string): Promise<PostgreSqlTunnelProfile | undefined> {
    const profiles = await manager.listProfiles();
    if (profiles.length === 0) {
        throw new Error('No PostgreSQL tunnel profiles are configured. Run “PostgreSQL: Configure Tunnel” first.');
    }
    if (profiles.length === 1) return profiles[0];
    const picked = await vscode.window.showQuickPick(
        profiles.map(profile => ({ label: profile.name, description: `${profile.targetId} · ${profile.serverUrl}:${profile.localPort}`, profile })),
        { placeHolder },
    );
    return picked?.profile;
}

async function input(label: string, value: string, password = false): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: label,
        value,
        password,
        ignoreFocusOut: true,
    });
}

export function registerPostgreSqlTunnelCommands(
    context: vscode.ExtensionContext,
    manager: PostgreSqlTunnelManager,
): vscode.Disposable[] {
    const configure = vscode.commands.registerCommand('postgresql.configureTunnel', async () => {
        try {
            const profiles = await manager.listProfiles();
            const selected = profiles.length > 0
                ? await vscode.window.showQuickPick([
                    { label: '$(add) New tunnel profile', profile: undefined },
                    ...profiles.map(profile => ({ label: profile.name, description: 'Edit existing profile', profile })),
                ], { placeHolder: 'Create or edit a PostgreSQL tunnel profile' })
                : { profile: undefined };
            if (!selected) return;

            const current = selected.profile;
            const id = current?.id ?? `tunnel-${Date.now()}`;
            const name = await input('Tunnel profile name', current?.name ?? 'PostgreSQL tunnel');
            if (name === undefined) return;
            const serverUrl = await input('HTTPS/WSS server URL (for example https://gateway.example.com)', current?.serverUrl ?? '');
            if (serverUrl === undefined) return;
            const targetId = await input('Named server target id', current?.targetId ?? 'reports');
            if (targetId === undefined) return;
            const portText = await input('Local TCP port', String(current?.localPort ?? postgresqlTunnelDefaults.localPort));
            if (portText === undefined) return;
            const existingToken = await manager.getToken(id);
            const token = await input('Tunnel bearer token (leave blank to keep the saved token)', '', true);
            if (token === undefined) return;
            await manager.saveProfile({ id, name, serverUrl, targetId, localPort: parsePort(portText) }, token || existingToken);
            vscode.window.showInformationMessage(`PostgreSQL tunnel profile “${name.trim()}” saved.`);
        } catch (error: unknown) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    });

    const start = vscode.commands.registerCommand('postgresql.startTunnel', async () => {
        try {
            const profile = await chooseProfile(manager, 'Select a PostgreSQL tunnel to start');
            if (!profile) return;
            const status = await manager.start(profile.id);
            vscode.window.showInformationMessage(`PostgreSQL tunnel listening on ${status.host}:${status.localPort} → ${status.targetId}.`);
        } catch (error: unknown) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    });

    const stop = vscode.commands.registerCommand('postgresql.stopTunnel', async () => {
        try {
            const statuses = manager.getStatuses();
            if (statuses.length === 0) {
                vscode.window.showInformationMessage('No PostgreSQL tunnels are running.');
                return;
            }
            const selected = statuses.length === 1
                ? statuses[0]
                : (await vscode.window.showQuickPick(
                    statuses.map(status => ({ label: status.name, description: `${status.host}:${status.localPort} → ${status.targetId}`, status })),
                    { placeHolder: 'Select a PostgreSQL tunnel to stop' },
                ))?.status;
            if (!selected) return;
            await manager.stop(selected.id);
            vscode.window.showInformationMessage(`PostgreSQL tunnel “${selected.name}” stopped.`);
        } catch (error: unknown) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
    });

    const status = vscode.commands.registerCommand('postgresql.tunnelStatus', () => {
        const statuses = manager.getStatuses();
        if (statuses.length === 0) {
            vscode.window.showInformationMessage('No PostgreSQL tunnels are running.');
            return;
        }
        const message = statuses.map(item => `${item.name}: ${item.host}:${item.localPort} → ${item.targetId} (${item.activeConnections} connection(s))`).join('\n');
        vscode.window.showInformationMessage(message);
    });

    context.subscriptions.push(configure, start, stop, status);
    return [configure, start, stop, status];
}
