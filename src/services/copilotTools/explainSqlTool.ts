import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';
import type { CopilotToolService } from './copilotToolService';

export interface IExplainSqlToolParameters {
    sql: string;
    database?: string;
    verbose?: boolean;
}

/**
 * Runs a read-only EXPLAIN and returns the semantic plan analysis.
 * Tuning advice is intentionally left to the agent + the performance skill.
 */
export class ExplainSqlTool implements vscode.LanguageModelTool<IExplainSqlToolParameters> {
    constructor(private copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExplainSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.verbose ? 'verbose' : 'standard';
        const database = options.input.database ? ` on ${options.input.database}` : '';
        const sqlPreview = options.input.sql?.substring(0, 80) + (options.input.sql?.length > 80 ? '...' : '');

        return {
            invocationMessage: `Analyzing ${mode} execution plan${database}...`,
            confirmationMessages: {
                title: 'Explain SQL',
                message: new vscode.MarkdownString(
                    `Run a read-only EXPLAIN ${mode} for:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\`${database ? `\n\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExplainSqlToolParameters>,
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
            logWithFallback('error', `[ExplainSqlTool] Failed to analyze execution plan: ${errorMsg}`, e);
            throw new Error(`Failed to analyze execution plan: ${errorMsg}`, { cause: e });
        }
    }
}
