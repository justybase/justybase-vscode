import type { MysqlAlterTableDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: MysqlAlterTableDesignerWebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();