import type { PostgresqlAlterTableDesignerWebviewToHostMessage } from './hostContracts.js';

interface VsCodeApi {
    postMessage(message: PostgresqlAlterTableDesignerWebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();