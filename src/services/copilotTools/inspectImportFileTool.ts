import * as vscode from 'vscode';

export interface IInspectImportFileToolParameters {
    filePath: string;
    sampleRows?: number;
}

export class InspectImportFileTool implements vscode.LanguageModelTool<IInspectImportFileToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IInspectImportFileToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath } = options.input;
        const sampleRows = options.input.sampleRows ?? 5;
        return {
            invocationMessage: `Inspecting import file ${filePath} (${sampleRows} sample rows)...`,
            confirmationMessages: {
                title: 'Inspect Import File',
                message: new vscode.MarkdownString(
                    `Inspect file **${filePath}** and infer import schema preview?\n\nSample rows: **${sampleRows}**`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IInspectImportFileToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, sampleRows } = options.input;
        if (!filePath || filePath.trim().length === 0) {
            throw new Error('filePath is required.');
        }

        const result = await this.copilotService.inspectImportFile(filePath, sampleRows ?? 5);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }
}

import { CopilotService } from '../copilotService';
