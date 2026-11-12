import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export interface IGetContextToolParameters {
    sql?: string;
    includeSchema?: boolean;
    includeDiagnostics?: boolean;
}

/**
 * Collects the active SQL context (dialect, connection, SQL, referenced DDL)
 * and current diagnostics in one call. This replaces the former
 * get_sql_schema/get_sql_diagnostics pair.
 */
export class GetContextTool implements vscode.LanguageModelTool<IGetContextToolParameters> {
    constructor(private copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetContextToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const source = options.input.sql ? 'provided SQL' : 'active editor';
        const details = [
            options.input.includeSchema === false ? undefined : 'referenced table DDL',
            options.input.includeDiagnostics === false ? undefined : 'parser/linter diagnostics'
        ].filter(Boolean);

        return {
            invocationMessage: `Collecting SQL context from ${source}...`,
            confirmationMessages: {
                title: 'Get SQL Context',
                message: new vscode.MarkdownString(
                    `Collect SQL, connection, and ${details.join(' and ')} from ${source}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetContextToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const context = await this.copilotService.getToolContext(
                options.input.sql,
                options.input.includeSchema ?? true,
                options.input.includeDiagnostics ?? true
            );
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(context)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to collect SQL context: ${errorMsg}`, { cause: e });
        }
    }
}
