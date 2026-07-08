import * as vscode from 'vscode';

export interface ISchemaToolParameters {
    sql?: string;
}

export class SchemaTool implements vscode.LanguageModelTool<ISchemaToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISchemaToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sqlSource = options.input.sql ? 'provided SQL' : 'current editor';

        return {
            invocationMessage: `Fetching table schema from ${sqlSource}...`,
            confirmationMessages: {
                title: 'Get SQL Schema',
                message: new vscode.MarkdownString(
                    `Analyze SQL and fetch table schemas (DDL) from the connected Netezza database?\n\n` +
                        `**Source:** ${sqlSource}\n\n` +
                        `**Tip:** Schema is optional in Netezza. Use \`DATABASE..TABLE\` (defaults to ADMIN) or \`SCHEMA.TABLE\`.`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISchemaToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            let schemaInfo: string;

            if (options.input.sql) {
                schemaInfo = await this.copilotService.getSchemaForSql(options.input.sql);
            } else {
                schemaInfo = await this.copilotService.getSchemaContextForCurrentSql();
            }

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(schemaInfo)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get SQL schema: ${errorMsg}. Make sure you have an active database connection.`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
