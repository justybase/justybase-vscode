import type {
    MigrationWizardHostToWebviewMessage,
    MigrationWizardWebviewToHostMessage,
} from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: MigrationWizardWebviewToHostMessage): void;
}

const fallbackApi: VsCodeApi = { postMessage() {} };

export const vscode: VsCodeApi = (() => {
    try {
        const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
        return typeof acquire === 'function' ? acquire() : fallbackApi;
    } catch {
        return fallbackApi;
    }
})();

export function postToHost(message: MigrationWizardWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): MigrationWizardHostToWebviewMessage {
    return message as MigrationWizardHostToWebviewMessage;
}
