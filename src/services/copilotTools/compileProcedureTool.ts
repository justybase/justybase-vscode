import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export interface ICompileProcedureToolParameters {
    sql: string;
    database?: string;
}

export class CompileProcedureTool implements vscode.LanguageModelTool<ICompileProcedureToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICompileProcedureToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';
        const sqlPreview = options.input.sql?.substring(0, 120) + (options.input.sql?.length > 120 ? '...' : '');

        return {
            invocationMessage: `Compiling procedure${dbInfo}...`,
            confirmationMessages: {
                title: 'Compile Procedure (CREATE OR REPLACE)',
                message: new vscode.MarkdownString(
                    `Execute the following procedure DDL (non-query)?\n\n\`\`\`sql\n${sqlPreview}\n\`\`\`${dbInfo ? `\n\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICompileProcedureToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { sql, database } = options.input;

            if (!sql) {
                throw new Error('Procedure SQL (CREATE OR REPLACE PROCEDURE...) is required.');
            }

            const result = await this.copilotService.compileProcedure(sql, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[CompileProcedureTool] Compilation failed: ${errorMsg}`, e);
            throw new Error(`Procedure compilation failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
