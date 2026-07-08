import * as vscode from 'vscode';

export interface IDependenciesToolParameters {
    objectName?: string;
    object?: string;
    objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE';
    database?: string;
}

export class DependenciesTool implements vscode.LanguageModelTool<IDependenciesToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDependenciesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const objectName = options.input.objectName || options.input.object || 'unknown';
        const dbInfo = options.input.database ? ` in ${options.input.database}` : '';
        const typeInfo = options.input.objectType ? ` (${options.input.objectType})` : '';

        return {
            invocationMessage: `Finding dependencies for ${objectName}${typeInfo}${dbInfo}...`,
            confirmationMessages: {
                title: 'Get Object Dependencies',
                message: new vscode.MarkdownString(
                    `Find all objects that depend on **${objectName}**${typeInfo}${dbInfo}?`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDependenciesToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const objectName = options.input.objectName || options.input.object;
            const { database, objectType } = options.input;

            if (!objectName) {
                throw new Error('Object name is required.');
            }

            const result = await this.copilotService.getObjectDependencies(objectName, database, objectType);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get dependencies: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
