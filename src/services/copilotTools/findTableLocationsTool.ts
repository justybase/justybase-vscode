import * as vscode from 'vscode';

export interface IFindTableLocationsToolParameters {
    tableName: string;
    sql?: string;
}

export class FindTableLocationsTool implements vscode.LanguageModelTool<IFindTableLocationsToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IFindTableLocationsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const tableName = options.input.tableName || 'unknown table';

        return {
            invocationMessage: `Searching for table "${tableName}" across all databases and schemas...`,
            confirmationMessages: {
                title: 'Find Table Locations',
                message: new vscode.MarkdownString(
                    `Search for table **${tableName}** across all accessible databases?\n\n` +
                    `**Note:** Schema defaults to ADMIN if not specified. You can also use:\n` +
                    `- \`TABLENAME\` - searches with default ADMIN schema\n` +
                    `- \`SCHEMA.TABLENAME\` - searches in specific schema\n` +
                    `- \`DATABASE..TABLENAME\` - Netezza-style (ADMIN schema)\n` +
                    `- \`DATABASE.SCHEMA.TABLENAME\` - fully qualified`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IFindTableLocationsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { tableName } = options.input;

            if (!tableName || tableName.trim().length === 0) {
                throw new Error('Table name is required. Provide tableName parameter.');
            }

            const result = await this.copilotService.findTableLocations(tableName);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(
                `Failed to find table locations: ${errorMsg}. Make sure you have an active database connection.`,
                { cause: e }
            );
        }
    }
}

import { CopilotService } from '../copilotService';
