import type { TestDataGeneratorWebviewToHostMessage } from './hostContracts.js';

interface TestDataGeneratorVsCodeApi {
    postMessage(message: TestDataGeneratorWebviewToHostMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
}

const fallbackVsCodeApi: TestDataGeneratorVsCodeApi = {
    postMessage() {},
    setState() {},
    getState() {
        return undefined;
    },
};

export const vscode: TestDataGeneratorVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (
            globalThis as { acquireVsCodeApi?: () => TestDataGeneratorVsCodeApi }
        ).acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function'
            ? acquireVsCodeApiFn()
            : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postToHost(message: TestDataGeneratorWebviewToHostMessage): void {
    vscode.postMessage(message);
}
