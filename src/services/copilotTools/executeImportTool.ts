import * as vscode from 'vscode';

export interface IExecuteImportToolParameters {
    filePath: string;
    targetTable: string;
    dryRun?: boolean;
    timeoutSeconds?: number;
}

export class ExecuteImportTool implements vscode.LanguageModelTool<IExecuteImportToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExecuteImportToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, targetTable } = options.input;
        const dryRun = options.input.dryRun ?? true;
        const mode = dryRun ? 'dry-run (no DB changes)' : 'execute import (writes to database)';

        return {
            invocationMessage: `${dryRun ? 'Validating' : 'Executing'} import for ${targetTable}...`,
            confirmationMessages: {
                title: 'Execute Import',
                message: new vscode.MarkdownString(
                    `Run **${mode}** for file **${filePath}** into table **${targetTable}**?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExecuteImportToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, targetTable, dryRun, timeoutSeconds } = options.input;
        if (!filePath || filePath.trim().length === 0) {
            throw new Error('filePath is required.');
        }
        if (!targetTable || targetTable.trim().length === 0) {
            throw new Error('targetTable is required.');
        }

        const result = await this.copilotService.executeImport(
            filePath,
            targetTable,
            dryRun ?? true,
            timeoutSeconds
        );
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }
}

import { CopilotService } from '../copilotService';
