import * as vscode from 'vscode';
import { logWithFallback } from '../../utils/logger';

export interface IExecuteProcedureToolParameters {
    procedureName: string;
    arguments?: string;
    database?: string;
}

export class ExecuteProcedureTool implements vscode.LanguageModelTool<IExecuteProcedureToolParameters> {
    constructor(private copilotService: CopilotService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExecuteProcedureToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const dbInfo = options.input.database ? ` on ${options.input.database}` : '';
        const argsStr = options.input.arguments ? `(${options.input.arguments})` : '()';
        const callPreview = `CALL ${options.input.procedureName}${argsStr}`;

        return {
            invocationMessage: `Executing procedure: ${callPreview}${dbInfo}...`,
            confirmationMessages: {
                title: 'Execute Procedure (CALL)',
                message: new vscode.MarkdownString(
                    `Execute the following stored procedure?\n\n\`\`\`sql\n${callPreview}\n\`\`\`${dbInfo ? `\n\n**Database:** ${options.input.database}` : ''}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExecuteProcedureToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const { procedureName, arguments: args, database } = options.input;

            if (!procedureName) {
                throw new Error('Procedure name is required.');
            }

            const result = await this.copilotService.executeProcedure(procedureName, args, database);

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (e: unknown) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logWithFallback('error', `[ExecuteProcedureTool] Execution failed: ${errorMsg}`, e);
            throw new Error(`Procedure execution failed: ${errorMsg}`, { cause: e });
        }
    }
}

import { CopilotService } from '../copilotService';
