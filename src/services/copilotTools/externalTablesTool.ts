import * as vscode from 'vscode';

export interface IExternalTablesToolParameters {
    database?: string;
    schema?: string;
    dataObjectPattern?: string;
}

export class ExternalTablesTool implements vscode.LanguageModelTool<IExternalTablesToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExternalTablesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` in ${options.input.database}` : ' across all databases';
        const schemaInfo = options.input.schema ? `, schema ${options.input.schema}` : '';
        const dataObjInfo = options.input.dataObjectPattern
            ? `, data object matching "${options.input.dataObjectPattern}"`
            : '';

        return {
            invocationMessage: `Fetching external tables${dbInfo}${schemaInfo}${dataObjInfo}...`,
            confirmationMessages: {
                title: 'Get External Tables',
                message: new vscode.MarkdownString(`Fetch list of external tables${dbInfo}${schemaInfo}${dataObjInfo}?`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExternalTablesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.getExternalTables(
                options.input.database,
                options.input.schema,
                options.input.dataObjectPattern
            );

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get external tables: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
