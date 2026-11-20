import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export interface IGetReferenceToolParameters {
    topic?: 'optimization' | 'nzplsql' | 'all';
}

/** Returns the Netezza reference for SQL authoring, NZPLSQL or performance. */
export class GetReferenceTool implements vscode.LanguageModelTool<IGetReferenceToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetReferenceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const topic = options.input.topic ?? 'all';
        const topicDescriptions: Record<string, string> = {
            optimization: 'SQL optimization best practices',
            nzplsql: 'NZPLSQL stored procedure syntax',
            all: 'all Netezza documentation'
        };

        return {
            invocationMessage: `Getting Netezza reference: ${topicDescriptions[topic]}...`,
            confirmationMessages: {
                title: 'Get Netezza Reference',
                message: new vscode.MarkdownString(`Retrieve **${topicDescriptions[topic]}** for IBM Netezza?`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetReferenceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const topic = options.input.topic ?? 'all';
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(this.copilotService.getNetezzaReference(topic))
        ]);
    }
}
