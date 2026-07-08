import * as vscode from 'vscode';

export interface ISearchSchemaToolParameters {
    searchTerm?: string;
    pattern?: string;
    objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'AGGREGATE' | 'SYNONYM' | 'EXTERNAL TABLE' | 'ALL';
    searchType?: 'tables' | 'columns' | 'all';
    database?: string;
}

export class SearchSchemaTool implements vscode.LanguageModelTool<ISearchSchemaToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchSchemaToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const searchTerm = options.input.searchTerm || options.input.pattern || '';
        const searchType = options.input.objectType || options.input.searchType || 'ALL';
        const dbInfo = options.input.database ? ` in ${options.input.database}` : '';

        return {
            invocationMessage: `Searching ${searchType} for "${searchTerm}"${dbInfo}...`,
            confirmationMessages: {
                title: 'Search Schema',
                message: new vscode.MarkdownString(
                    `Search for ${searchType} matching pattern **"${searchTerm}"**${dbInfo}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISearchSchemaToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const pattern = options.input.searchTerm || options.input.pattern;
            const searchType = options.input.objectType || options.input.searchType || 'ALL';
            const { database } = options.input;

            if (!pattern) {
                throw new Error('Search pattern is required.');
            }

            const result = await this.copilotService.searchSchema(pattern, searchType, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Schema search failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
