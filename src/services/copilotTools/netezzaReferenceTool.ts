import * as vscode from 'vscode';

export interface INetezzaReferenceToolParameters {
    topic?: 'optimization' | 'nzplsql' | 'all';
}

export class NetezzaReferenceTool implements vscode.LanguageModelTool<INetezzaReferenceToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<INetezzaReferenceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const topic = options.input.topic || 'all';
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
        options: vscode.LanguageModelToolInvocationOptions<INetezzaReferenceToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const topic = options.input.topic || 'all';
        const result = this.copilotService.getNetezzaReference(topic);

        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }
}

import { CopilotService } from '../copilotService';
