import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export interface IRunDiagnosticQueriesToolParameters {
    queries: string[];
    database?: string;
}

export class RunDiagnosticQueriesTool implements vscode.LanguageModelTool<IRunDiagnosticQueriesToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IRunDiagnosticQueriesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const count = options.input.queries?.length || 0;
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';

        return {
            invocationMessage: `Running ${count} diagnostic quer${count === 1 ? 'y' : 'ies'}${dbInfo}...`,
            confirmationMessages: {
                title: 'Run Diagnostic Queries',
                message: new vscode.MarkdownString(
                    `Run **${count}** diagnostic SQL quer${count === 1 ? 'y' : 'ies'} to validate correctness?${dbInfo ? `\n\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IRunDiagnosticQueriesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { queries, database } = options.input;

            if (!queries || queries.length === 0) {
                throw new Error('At least one diagnostic SQL query is required.');
            }

            const result = await this.copilotService.runDiagnosticQueries(queries, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[RunDiagnosticQueriesTool] Diagnostic queries failed: ${errorMsg}`, e);
            throw new Error(`Diagnostic queries failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
