import type { Db2PartitionDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: Db2PartitionDesignerWebviewToHostMessage): void;
}

const fallbackVsCodeApi: VsCodeApi = { postMessage() {} };

export const vscode: VsCodeApi = (() => {
    const acquire = (globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
    return typeof acquire === 'function' ? acquire() : fallbackVsCodeApi;
})();
