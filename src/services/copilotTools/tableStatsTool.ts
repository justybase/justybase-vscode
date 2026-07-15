import * as vscode from 'vscode';

export interface ITableStatsToolParameters {
    tableName?: string;
    table?: string;
    database?: string;
}

export class TableStatsTool implements vscode.LanguageModelTool<ITableStatsToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ITableStatsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const tableName = options.input.tableName || options.input.table || 'unknown';
        const dbInfo = options.input.database ? ` in ${options.input.database}` : '';
        const mode = 'quick';

        return {
            invocationMessage: `Getting ${mode} statistics for ${tableName}${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Table Statistics',
                message: new vscode.MarkdownString(
                    `Fetch catalog-based ${mode} statistics for **${tableName}**${dbInfo}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ITableStatsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const tableName = options.input.tableName || options.input.table;
            const { database } = options.input;
            if (!tableName) {
                throw new Error('Table name is required.');
            }

            const result = await this.copilotService.getTableStats(tableName, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get table statistics: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
