import * as vscode from 'vscode';

export interface IGetSqlDiagnosticsToolParameters {
    includeWarnings?: boolean;
}

export class GetSqlDiagnosticsTool implements vscode.LanguageModelTool<IGetSqlDiagnosticsToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetSqlDiagnosticsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const includeWarnings = options.input.includeWarnings !== false;
        return {
            invocationMessage: 'Collecting SQL diagnostics from active editor...',
            confirmationMessages: {
                title: 'Get SQL Diagnostics',
                message: new vscode.MarkdownString(
                    `Collect SQL linter diagnostics with codes from the active SQL document.\n\n` +
                    `**Include warnings:** ${includeWarnings ? 'Yes' : 'No (errors only)'}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetSqlDiagnosticsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const includeWarnings = options.input.includeWarnings !== false;
            const result = await this.copilotService.getSqlDiagnostics(includeWarnings);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to read SQL diagnostics: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
