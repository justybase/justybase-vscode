import type { TableDesignerWebviewToHostMessage } from './hostContracts.js';

interface TableDesignerVsCodeApi {
    postMessage(message: TableDesignerWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: TableDesignerVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: TableDesignerVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => TableDesignerVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: TableDesignerWebviewToHostMessage): void {
    vscode.postMessage(message);
}
