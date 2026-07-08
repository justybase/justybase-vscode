import * as vscode from 'vscode';

export interface ISchemasToolParameters {
    database?: string;
}

export class SchemasTool implements vscode.LanguageModelTool<ISchemasToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISchemasToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` in ${options.input.database}` : ' across all databases';

        return {
            invocationMessage: `Fetching schemas${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Schemas',
                message: new vscode.MarkdownString(`Fetch list of schemas${dbInfo}?`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISchemasToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getSchemas(options.input.database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get schemas: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
