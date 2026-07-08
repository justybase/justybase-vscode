import * as vscode from 'vscode';

export interface IGetCommentsToolParameters {
    tableName: string;
    database?: string;
    schema?: string;
    includeColumns?: boolean;
}

export class GetCommentsTool implements vscode.LanguageModelTool<IGetCommentsToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetCommentsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const tableName = options.input.tableName || 'unknown';
        const includeColumns = options.input.includeColumns !== false; // default true
        const scope = includeColumns ? 'table and column comments' : 'table comment only';

        return {
            invocationMessage: `Fetching ${scope} for ${tableName}...`,
            confirmationMessages: {
                title: 'Get Comments',
                message: new vscode.MarkdownString(
                    `Fetch comments (DESCRIPTION) for **${tableName}**?\n\n` +
                    `**Include column comments:** ${includeColumns ? 'Yes' : 'No'}\n\n` +
                    `**Tip:** If schema is not specified, searches across all schemas. Use \`DATABASE..TABLE\` for ADMIN schema or \`SCHEMA.TABLE\` for specific schema.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetCommentsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { tableName, database, schema, includeColumns } = options.input;

            if (!tableName || tableName.trim().length === 0) {
                throw new Error('Table name is required. Provide tableName parameter.');
            }

            const commentsInfo = await this.copilotService.getComments(
                tableName,
                database,
                schema,
                includeColumns !== false
            );

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(commentsInfo)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(
                `Failed to get comments: ${errorMsg}. Make sure you have an active database connection.`,
                { cause: e }
            );
        }
    }
}

import { CopilotService } from '../copilotService';
