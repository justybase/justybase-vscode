import * as vscode from 'vscode';
import { activateCoreExtension } from '@justybase/vscode-companion-adapter';
import { accessDialect } from './accessDialect';
import { clearStaleAccessLock, type AccessLockClearResult } from './accessFileLock';

const ACCESS_FILE_FILTER = {
    'Microsoft Access databases': ['mdb', 'accdb'],
};

function isAccessFileUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
    return uri?.scheme === 'file' && /\.(?:mdb|accdb)$/i.test(uri.fsPath);
}

async function resolveAccessFile(resource: vscode.Uri | undefined): Promise<string | undefined> {
    if (isAccessFileUri(resource)) {
        return resource.fsPath;
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (isAccessFileUri(activeUri)) {
        return activeUri.fsPath;
    }
    const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        openLabel: 'Select Access database',
        filters: ACCESS_FILE_FILTER,
    });
    return selection?.[0]?.fsPath;
}

function reportClearResult(databasePath: string, result: AccessLockClearResult): void {
    if (result.cleared) {
        void vscode.window.showInformationMessage(
            `Removed the stale Microsoft Access lock file for '${databasePath}'.`,
        );
        return;
    }
    switch (result.reason) {
        case 'live-owner':
            void vscode.window.showWarningMessage(
                `The lock for '${databasePath}' is held by a running JustyBase process`
                + `${result.owner ? ` (PID ${result.owner.pid} on ${result.owner.host})` : ''}. `
                + 'Close that window before clearing the lock.',
            );
            return;
        case 'held':
            void vscode.window.showErrorMessage(
                `The lock file for '${databasePath}' is currently in use and cannot be removed. `
                + 'Close Microsoft Access or the other process, then try again.',
            );
            return;
        case 'missing':
            void vscode.window.showInformationMessage(
                `No Microsoft Access lock file exists for '${databasePath}'.`,
            );
            return;
        case 'not-a-database':
            void vscode.window.showErrorMessage(
                `'${databasePath}' is not a Microsoft Access .mdb or .accdb file.`,
            );
            return;
        default:
            void vscode.window.showErrorMessage(
                `The Microsoft Access lock file for '${databasePath}' could not be cleared.`,
            );
    }
}

async function clearStaleLockCommand(resource?: vscode.Uri): Promise<void> {
    const databasePath = await resolveAccessFile(resource);
    if (!databasePath) {
        return;
    }
    const confirmation = await vscode.window.showWarningMessage(
        `Clear the lock file for '${databasePath}'? `
        + 'Only do this when Microsoft Access and every JustyBase window using this file are closed.',
        { modal: true },
        'Clear lock file',
    );
    if (confirmation !== 'Clear lock file') {
        return;
    }
    reportClearResult(databasePath, await clearStaleAccessLock(databasePath));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(accessDialect);
    context.subscriptions.push(
        vscode.commands.registerCommand('justybase.access.clearStaleLock', clearStaleLockCommand),
    );
}

export function deactivate(): void {}
