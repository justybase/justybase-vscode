import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export interface IExecuteQueryToolParameters {
    sql: string;
    database?: string;
    maxRows?: number;
}

export class ExecuteQueryTool implements vscode.LanguageModelTool<IExecuteQueryToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExecuteQueryToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const maxRows = options.input.maxRows || 100;
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';
        const sqlPreview = options.input.sql?.substring(0, 100) + (options.input.sql?.length > 100 ? '...' : '');

        return {
            invocationMessage: `Executing SELECT query${dbInfo} (max ${maxRows} rows)...`,
            confirmationMessages: {
                title: 'Execute SQL Query',
                message: new vscode.MarkdownString(
                    `Execute the following SQL query (read-only)?\n\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n\n**Max Rows:** ${maxRows}${dbInfo ? `\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExecuteQueryToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { sql, maxRows, database } = options.input;

            if (!sql) {
                throw new Error('SQL query is required.');
            }

            const result = await this.copilotService.executeSelectQuery(sql, maxRows || 100, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[ExecuteQueryTool] Query execution failed: ${errorMsg}`, e);
            throw new Error(`Query execution failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
