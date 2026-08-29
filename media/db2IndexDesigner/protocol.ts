import type { Db2IndexDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: Db2IndexDesignerWebviewToHostMessage): void;
}

const fallbackVsCodeApi: VsCodeApi = { postMessage() {} };

export const vscode: VsCodeApi = (() => {
    const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
    return typeof acquire === 'function' ? acquire() : fallbackVsCodeApi;
})();
