import * as vscode from 'vscode';

export interface IValidateSqlOnDatabaseToolParameters {
    sql?: string;
    database?: string;
}

export class ValidateSqlOnDatabaseTool implements vscode.LanguageModelTool<IValidateSqlOnDatabaseToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IValidateSqlOnDatabaseToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sqlPreview = options.input.sql
            ? options.input.sql.substring(0, 80) + (options.input.sql.length > 80 ? '...' : '')
            : 'Current SQL editor content';
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';

        return {
            invocationMessage: `Validating SQL on database${dbInfo}...`,
            confirmationMessages: {
                title: 'Validate SQL on Database',
                message: new vscode.MarkdownString(`Validate SQL using EXPLAIN${dbInfo}:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\``)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IValidateSqlOnDatabaseToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const inputSql = options.input.sql;
            const sql = inputSql && inputSql.trim().length > 0 ? inputSql : vscode.window.activeTextEditor?.document.getText();
            const { database } = options.input;

            if (!sql) {
                throw new Error('SQL is required (provide input.sql or open an active SQL editor).');
            }

            const result = await this.copilotService.validateSqlOnDatabase(sql, database);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Database SQL validation failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
