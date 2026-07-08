import * as vscode from 'vscode';

export interface IColumnsToolParameters {
    tables: string[];
    database?: string;
}

export class ColumnsTool implements vscode.LanguageModelTool<IColumnsToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IColumnsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const tableCount = options.input.tables?.length || 0;
        const dbInfo = options.input.database ? ` from database ${options.input.database}` : '';

        return {
            invocationMessage: `Fetching column metadata for ${tableCount} table(s)${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Table Columns',
                message: new vscode.MarkdownString(
                    `Fetch column definitions for the following tables${dbInfo}?\n\n` +
                        `**Tables:** ${options.input.tables?.join(', ') || 'none'}\n\n` +
                        `**Tip:** In Netezza, schema is optional. Use \`DATABASE..TABLE\` syntax (double dots skip schema, defaults to ADMIN).`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IColumnsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { tables, database } = options.input;

            if (!tables || tables.length === 0) {
                throw new Error('No tables specified. Please provide at least one table name.');
            }

            const columnsInfo = await this.copilotService.getColumnsForTables(tables, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(columnsInfo)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get columns: ${errorMsg}. Make sure you have an active database connection.`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
