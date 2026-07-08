import * as vscode from 'vscode';

export interface IViewsToolParameters {
    database?: string;
    schema?: string;
}

export class ViewsTool implements vscode.LanguageModelTool<IViewsToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IViewsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` in ${options.input.database}` : ' across all databases';
        const schemaInfo = options.input.schema ? `, schema ${options.input.schema}` : '';

        return {
            invocationMessage: `Fetching views${dbInfo}${schemaInfo}...`,
            confirmationMessages: {
                title: 'Get Views',
                message: new vscode.MarkdownString(`Fetch list of views${dbInfo}${schemaInfo}?`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IViewsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getViews(options.input.database, options.input.schema);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get views: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
