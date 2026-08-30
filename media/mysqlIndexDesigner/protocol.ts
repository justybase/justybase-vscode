import type { MysqlIndexDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: MysqlIndexDesignerWebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
