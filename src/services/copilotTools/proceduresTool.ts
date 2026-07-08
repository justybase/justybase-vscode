import * as vscode from 'vscode';

export interface IProceduresToolParameters {
    database?: string;
    schema?: string;
}

export class ProceduresTool implements vscode.LanguageModelTool<IProceduresToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IProceduresToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` in ${options.input.database}` : ' across all databases';
        const schemaInfo = options.input.schema ? `, schema ${options.input.schema}` : '';

        return {
            invocationMessage: `Fetching procedures${dbInfo}${schemaInfo}...`,
            confirmationMessages: {
                title: 'Get Procedures',
                message: new vscode.MarkdownString(`Fetch list of stored procedures${dbInfo}${schemaInfo}?`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IProceduresToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getProcedures(options.input.database, options.input.schema);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get procedures: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
