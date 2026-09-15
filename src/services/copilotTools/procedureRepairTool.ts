import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';
import { extractProcedureIdentity, type ProcedureCallArgument, type ProcedureRepairMode } from '../copilot/tools/procedureRepairUtils';

export interface IProcedureRepairToolParameters {
    mode: ProcedureRepairMode;
    sql?: string;
    callArguments?: ProcedureCallArgument[];
}

export class ProcedureRepairTool implements vscode.LanguageModelTool<IProcedureRepairToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IProcedureRepairToolParameters>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.mode;
        const inputSql = options.input.sql?.trim();
        const editorSql = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection).trim();
        const sqlPreview = truncateSql(inputSql || editorSql || 'the complete procedure block from the active editor');
        const identity = inputSql ? extractProcedureIdentity(inputSql) : undefined;
        const targetName = identity?.name || 'the selected procedure';
        const callNotice = mode === 'compile_and_call'
            ? '\n\nAfter compilation, a separate modal confirmation will be required before the test CALL is executed. The CALL may modify database data.'
            : '';

        return {
            invocationMessage: mode === 'compile_and_call'
                ? `Compile and test ${targetName}...`
                : `Compile ${targetName}...`,
            confirmationMessages: {
                title: 'Compile or repair Netezza procedure',
                message: new vscode.MarkdownString(
                    `This operation executes the procedure DDL against the connection assigned to the active SQL document.\n\n` +
                    `**Mode:** ${mode}\n\n` +
                    `\`\`\`sql\n${sqlPreview}\n\`\`\`\n\n` +
                    `The repair workflow allows at most three attempts.${callNotice}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IProcedureRepairToolParameters>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.copilotService.repairProcedure(options.input, token);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Netezza procedure repair failed: ${message}`, { cause: error });
        }
    }
}

function truncateSql(sql: string): string {
    const maxLength = 1200;
    return sql.length <= maxLength ? sql : `${sql.slice(0, maxLength)}\n...`;
}
