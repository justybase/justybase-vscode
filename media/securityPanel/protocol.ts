import type {
    SecurityPanelHostToWebviewMessage,
    SecurityPanelWebviewToHostMessage,
} from './hostContracts.js';

interface SecurityPanelVsCodeApi {
    postMessage(message: SecurityPanelWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: SecurityPanelVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: SecurityPanelVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => SecurityPanelVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: SecurityPanelWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): SecurityPanelHostToWebviewMessage {
    return message as SecurityPanelHostToWebviewMessage;
}
