import * as vscode from 'vscode';

export interface IGetDDLToolParameters {
    objectName: string;
    objectType: 'table' | 'view' | 'procedure' | 'external table' | 'synonym' | 'nickname' | 'alias';
    database?: string;
    schema?: string;
}

/**
 * GetDDLTool - Copilot tool for fetching DDL of database objects
 * 
 * Wraps the existing generateDDL function to allow Copilot to fetch
 * DDL for tables, views, procedures, external tables, synonyms, nicknames, and aliases by name.
 * 
 * Supports various name formats:
 * - TABLENAME (uses current database, default schema ADMIN)
 * - SCHEMA.TABLENAME (uses current database)
 * - DATABASE..TABLENAME (Netezza-style, searches across all schemas)
 * - DATABASE.SCHEMA.TABLENAME (fully qualified)
 */
export class GetDDLTool implements vscode.LanguageModelTool<IGetDDLToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetDDLToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { objectName, database, schema } = options.input;
        const objectType = (options.input.objectType || 'table').toLowerCase() as IGetDDLToolParameters['objectType'];
        const dbInfo = database ? ` in ${database}` : '';
        const schemaInfo = schema ? `.${schema}` : '';
        const typeName = objectType.toUpperCase();

        return {
            invocationMessage: `Fetching ${typeName} DDL for ${objectName}${dbInfo}${schemaInfo}...`,
            confirmationMessages: {
                title: `Get ${typeName} DDL`,
                message: new vscode.MarkdownString(
                    'Fetch DDL (CREATE statement) for ' + objectType + ' **' + objectName + '**' + dbInfo + schemaInfo + '?\n\n' +
                    '**Tip:** In Netezza, you can use:\n' +
                    '- `TABLENAME` (current database, default schema ADMIN)\n' +
                    '- `SCHEMA.TABLENAME` (current database)\n' +
                    '- `DATABASE..TABLENAME` (Netezza-style, searches all schemas)\n' +
                    '- `DATABASE.SCHEMA.TABLENAME` (fully qualified)'
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetDDLToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { objectName, database, schema } = options.input;
            const objectType = (options.input.objectType || 'table').toLowerCase();

            if (!objectName) {
                throw new Error('Object name is required.');
            }

            const validTypes = ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'];
            if (!objectType || !validTypes.includes(objectType.toLowerCase())) {
                throw new Error('Object type must be one of: ' + validTypes.join(', ') + '.');
            }

            const result = await this.copilotService.getDDL({
                objectName,
                objectType,
                database,
                schema
            });

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error('Failed to get DDL: ' + errorMsg, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
