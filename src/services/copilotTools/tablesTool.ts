import * as vscode from 'vscode';

export interface ITablesToolParameters {
    database?: string;
    schema?: string;
}

export class TablesTool implements vscode.LanguageModelTool<ITablesToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITablesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const schemaInfo = options.input.schema ? ` (schema: ${options.input.schema})` : '';
        const dbInfo = options.input.database ? `database ${options.input.database}` : 'all databases';

        return {
            invocationMessage: `Fetching tables from ${dbInfo}${schemaInfo}...`,
            confirmationMessages: {
                title: 'Get Tables List',
                message: new vscode.MarkdownString(
                    `Fetch list of tables from **${dbInfo}**${schemaInfo}?\n\n` +
                    `**Tip:** If schema is not specified, use ADMIN as default.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITablesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { database, schema } = options.input;

            const tablesInfo = await this.copilotService.getTablesFromDatabase(database, schema);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(tablesInfo)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get tables: ${errorMsg}. Make sure you have an active database connection.`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
