import * as vscode from 'vscode';

export interface IProposeImportMappingToolParameters {
    filePath: string;
    targetTable: string;
}

export class ProposeImportMappingTool implements vscode.LanguageModelTool<IProposeImportMappingToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IProposeImportMappingToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, targetTable } = options.input;
        return {
            invocationMessage: `Proposing import mapping from ${filePath} to ${targetTable}...`,
            confirmationMessages: {
                title: 'Propose Import Mapping',
                message: new vscode.MarkdownString(
                    `Generate inferred mapping for file **${filePath}** into table **${targetTable}**?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IProposeImportMappingToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, targetTable } = options.input;
        if (!filePath || filePath.trim().length === 0) {
            throw new Error('filePath is required.');
        }
        if (!targetTable || targetTable.trim().length === 0) {
            throw new Error('targetTable is required.');
        }

        const result = await this.copilotService.proposeImportMapping(filePath, targetTable);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }
}

import { CopilotService } from '../copilotService';
