import type {
    SessionMonitorHostToWebviewMessage,
    SessionMonitorWebviewToHostMessage,
} from './hostContracts.js';

interface SessionMonitorVsCodeApi {
    postMessage(message: SessionMonitorWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: SessionMonitorVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: SessionMonitorVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => SessionMonitorVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: SessionMonitorWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): SessionMonitorHostToWebviewMessage {
    return message as SessionMonitorHostToWebviewMessage;
}
