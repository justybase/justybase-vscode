import type { MysqlPartitionDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: MysqlPartitionDesignerWebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
