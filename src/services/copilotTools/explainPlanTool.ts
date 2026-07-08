import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export interface IExplainPlanToolParameters {
    sql: string;
    database?: string;
    verbose?: boolean;
}

export class ExplainPlanTool implements vscode.LanguageModelTool<IExplainPlanToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExplainPlanToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.verbose ? 'verbose' : 'standard';
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';
        const sqlPreview = options.input.sql?.substring(0, 80) + (options.input.sql?.length > 80 ? '...' : '');

        return {
            invocationMessage: `Getting ${mode} execution plan${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Execution Plan',
                message: new vscode.MarkdownString(
                    `Get ${mode} execution plan for:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\`${dbInfo ? `\n\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExplainPlanToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { sql, verbose, database } = options.input;

            if (!sql) {
                throw new Error('SQL query is required.');
            }

            const result = await this.copilotService.getExplainPlanAnalysis(sql, verbose || false, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[ExplainPlanTool] Failed to get execution plan: ${errorMsg}`, e);
            throw new Error(`Failed to get execution plan: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
