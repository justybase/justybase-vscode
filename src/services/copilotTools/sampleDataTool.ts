import * as vscode from 'vscode';

export interface ISampleDataToolParameters {
    tableName?: string;
    table?: string;
    database?: string;
    limit?: number;
    sampleSize?: number;
}

export class SampleDataTool implements vscode.LanguageModelTool<ISampleDataToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ISampleDataToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const tableName = options.input.tableName || options.input.table || 'unknown';
        const size = options.input.limit ?? options.input.sampleSize ?? 10;
        const dbInfo = options.input.database ? ` from ${options.input.database}` : '';

        return {
            invocationMessage: `Fetching ${size} sample rows from ${tableName}${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Sample Data',
                message: new vscode.MarkdownString(
                    `Fetch ${size} sample rows from table **${tableName}**${dbInfo}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISampleDataToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const tableName = options.input.tableName || options.input.table;
            const { database } = options.input;
            const limit = options.input.limit ?? options.input.sampleSize ?? 10;

            if (!tableName) {
                throw new Error('Table name is required.');
            }

            const result = await this.copilotService.getSampleData(tableName, database, limit);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get sample data: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
