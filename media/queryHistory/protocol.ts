import type {
    QueryHistoryExtendedStateSnapshot,
    QueryHistoryWebviewStateSnapshot,
    QueryHistoryWebviewToHostMessage,
} from './hostContracts.js';

interface QueryHistoryVsCodeApi {
    postMessage(message: QueryHistoryWebviewToHostMessage): void;
    setState(
        state: QueryHistoryWebviewStateSnapshot | QueryHistoryExtendedStateSnapshot,
    ): void;
    getState():
        | QueryHistoryWebviewStateSnapshot
        | QueryHistoryExtendedStateSnapshot
        | undefined;
}

const fallbackVsCodeApi: QueryHistoryVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

declare global {
    interface Window {
        acquireVsCodeApi?: () => QueryHistoryVsCodeApi;
    }
}

export const vscode: QueryHistoryVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = window.acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: QueryHistoryWebviewToHostMessage): void {
    vscode.postMessage(message);
}

export function asHostMessage(message: unknown): import('./hostContracts.js').QueryHistoryHostToWebviewMessage {
    return message as import('./hostContracts.js').QueryHistoryHostToWebviewMessage;
}
