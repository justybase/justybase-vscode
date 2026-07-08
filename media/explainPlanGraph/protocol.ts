import type { ExplainPlanGraphWebviewToHostMessage } from './hostContracts.js';

interface ExplainPlanGraphVsCodeApi {
    postMessage(message: ExplainPlanGraphWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: ExplainPlanGraphVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: ExplainPlanGraphVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => ExplainPlanGraphVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: ExplainPlanGraphWebviewToHostMessage): void {
    vscode.postMessage(message);
}
