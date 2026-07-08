import * as vscode from 'vscode';

export interface IValidateSqlToolParameters {
    sql?: string;
}

export class ValidateSqlTool implements vscode.LanguageModelTool<IValidateSqlToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IValidateSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sqlPreview = options.input.sql
            ? options.input.sql.substring(0, 80) + (options.input.sql.length > 80 ? '...' : '')
            : 'Current SQL editor content';

        return {
            invocationMessage: 'Validating SQL syntax...',
            confirmationMessages: {
                title: 'Validate SQL',
                message: new vscode.MarkdownString(`Validate syntax of:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\``)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const inputSql = options.input.sql;
            const sql = inputSql && inputSql.trim().length > 0 ? inputSql : vscode.window.activeTextEditor?.document.getText();

            if (!sql) {
                throw new Error('SQL is required (provide input.sql or open an active SQL editor).');
            }

            const result = await this.copilotService.validateSql(sql);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`SQL validation failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
