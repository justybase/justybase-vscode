import * as vscode from 'vscode';

export interface ITuningAdviceToolParameters {
    sql?: string;
    database?: string;
    analyzeAllTables?: boolean;
    maxTables?: number;
}

export class TuningAdviceTool implements vscode.LanguageModelTool<ITuningAdviceToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITuningAdviceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';
        const analyzeAllTables = options.input.analyzeAllTables !== false;
        const maxTables = Math.min(20, Math.max(1, options.input.maxTables ?? 5));
        const sqlPreview = options.input.sql
            ? options.input.sql.substring(0, 120) + (options.input.sql.length > 120 ? '...' : '')
            : 'active SQL selection/document';

        return {
            invocationMessage: `Generating SQL tuning advice${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Tuning Advice',
                message: new vscode.MarkdownString(
                    `Generate heuristic tuning advice${dbInfo} for:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n\n` +
                    `This runs read-only diagnostics (EXPLAIN + table stats lookup). ` +
                    `Scope: ${analyzeAllTables ? `up to ${maxTables} table(s)` : 'first referenced table only'}.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITuningAdviceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getTuningAdvice(
                options.input.sql,
                options.input.database,
                options.input.analyzeAllTables !== false,
                Math.min(20, Math.max(1, options.input.maxTables ?? 5))
            );
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get tuning advice: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
