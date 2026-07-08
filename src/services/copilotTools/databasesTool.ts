import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export type IDatabasesToolParameters = Record<string, never>;

export class DatabasesTool implements vscode.LanguageModelTool<IDatabasesToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<IDatabasesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Fetching list of databases...',
            confirmationMessages: {
                title: 'Get Databases',
                message: new vscode.MarkdownString('Fetch list of all databases accessible via the current connection?')
            }
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getDatabases();

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[DatabasesTool] Failed to get databases: ${errorMsg}`, e);
            throw new Error(`Failed to get databases: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
