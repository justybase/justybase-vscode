import type {
    FileConnectionPanelHostToWebviewMessage,
    FileConnectionPanelWebviewToHostMessage,
} from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: FileConnectionPanelWebviewToHostMessage): void;
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

export function postToHost(message: FileConnectionPanelWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): FileConnectionPanelHostToWebviewMessage {
    return message as FileConnectionPanelHostToWebviewMessage;
}
