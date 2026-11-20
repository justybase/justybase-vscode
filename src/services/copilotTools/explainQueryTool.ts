import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export interface IExplainQueryToolParameters {
    sql: string;
    database?: string;
    verbose?: boolean;
    analyze?: boolean;
}

/**
 * Runs a read-only EXPLAIN. With `analyze` (default true) it returns the
 * structural analysis; otherwise it returns the raw plan notices.
 */
export class ExplainQueryTool implements vscode.LanguageModelTool<IExplainQueryToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExplainQueryToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.verbose ? 'verbose' : 'standard';
        const database = options.input.database ? ` on ${options.input.database}` : '';
        const sql = options.input.sql ?? '';
        const sqlPreview = sql.length > 200 ? `${sql.slice(0, 199)}…` : sql;

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
        options: vscode.LanguageModelToolInvocationOptions<IExplainQueryToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const sql = options.input.sql?.trim();
        if (!sql) {
            throw new Error('SQL is required.');
        }
        try {
            const analyze = options.input.analyze !== false;
            const result = analyze
                ? await this.copilotService.getExplainPlanAnalysis(sql, options.input.verbose === true, options.input.database)
                : await this.copilotService.getExplainPlan(sql, options.input.verbose === true, options.input.database);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to analyze execution plan: ${message}`, { cause: error });
        }
    }
}
