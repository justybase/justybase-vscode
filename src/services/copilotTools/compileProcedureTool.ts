import * as vscode from 'vscode';
import { shortObjectName } from '../../core/assistant/objectNames';
import type { CopilotToolService } from './copilotToolService';
import { extractProcedureIdentity, type ProcedureCallArgument, type ProcedureRepairMode } from '../copilot/tools/procedureRepairUtils';

export interface ICompileProcedureToolParameters {
    mode: ProcedureRepairMode;
    sql?: string;
    callArguments?: ProcedureCallArgument[];
    confirm?: string;
}

/**
 * Compiles (CREATE / CREATE OR REPLACE) a Netezza NZPLSQL procedure and
 * optionally runs a test CALL. The CALL executes procedure logic and requires
 * the full access profile plus a confirmation value naming the procedure.
 */
export class CompileProcedureTool implements vscode.LanguageModelTool<ICompileProcedureToolParameters> {
    private readonly confirmedDdlTargets = new Map<string, number>();

    constructor(
        private readonly copilotService: CopilotToolService,
        private readonly allowWrites: boolean = true,
        private readonly allowDestructive: boolean = true,
    ) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ICompileProcedureToolParameters>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.mode;
        const inputSql = options.input.sql?.trim();
        const editorSql = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection).trim();
        const sqlPreview = truncateSql(inputSql || editorSql || 'the complete procedure block from the active editor');
        const identity = inputSql ? extractProcedureIdentity(inputSql) : undefined;
        const targetName = identity?.name || 'the selected procedure';
        const confirmationKey = buildConfirmationKey(options.input);
        const now = Date.now();
        const confirmedAt = this.confirmedDdlTargets.get(confirmationKey);
        const ddlConfirmationValid = confirmedAt !== undefined && now - confirmedAt < 10 * 60 * 1000;
        const callNotice = mode === 'compile_and_call'
            ? '\n\nAfter compilation, the test CALL requires the full access profile and `confirm` equal to the procedure name. The CALL may modify database data.'
            : '';

        const prepared: vscode.PreparedToolInvocation = {
            invocationMessage: mode === 'compile_and_call'
                ? `Compile and test ${targetName}...`
                : `Compile ${targetName}...`,
        };
        if (!ddlConfirmationValid) {
            prepared.confirmationMessages = {
                title: 'Compile or repair Netezza procedure',
                message: new vscode.MarkdownString(
                    `This operation executes the procedure DDL against the connection assigned to the active SQL document.\n\n` +
                    `**Mode:** ${mode}\n\n` +
                    `\`\`\`sql\n${sqlPreview}\n\`\`\`\n\n` +
                    `The repair workflow allows at most three attempts.${callNotice}`
                )
            };
        }
        return prepared;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICompileProcedureToolParameters>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.allowWrites) {
            throw new Error('Compiling procedures requires the "read-write" or "full" access profile in JustyBase AI Tools settings.');
        }

        if (options.input.mode === 'compile_and_call') {
            if (!this.allowDestructive) {
                throw new Error('compile_and_call requires the "full" access profile in JustyBase AI Tools settings.');
            }
            const sql = resolveProcedureSql(options.input.sql);
            const identity = sql ? extractProcedureIdentity(sql) : undefined;
            const target = identity ? shortObjectName(identity.name) : undefined;
            if (!target) {
                throw new Error('Could not determine the procedure name from the CREATE PROCEDURE block.');
            }
            const confirm = options.input.confirm?.trim();
            if (!confirm || confirm.toLowerCase() !== target.toLowerCase()) {
                throw new Error(`compile_and_call requires confirm equal to the procedure name "${target}".`);
            }
        }

        try {
            this.confirmedDdlTargets.set(buildConfirmationKey(options.input), Date.now());
            const result = await this.copilotService.repairProcedure(options.input, token);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Netezza procedure compilation failed: ${message}`, { cause: error });
        }
    }
}

function resolveProcedureSql(sqlInput?: string): string {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : '';
    return sqlInput?.trim() || selected || editor?.document.getText().trim() || '';
}

function truncateSql(sql: string): string {
    const maxLength = 1200;
    return sql.length <= maxLength ? sql : `${sql.slice(0, maxLength)}\n...`;
}

function buildConfirmationKey(input: ICompileProcedureToolParameters): string {
    const editor = vscode.window.activeTextEditor;
    const candidateSql = input.sql?.trim()
        || (editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : '')
        || 'active-editor-procedure';
    const identity = extractProcedureIdentity(candidateSql);
    return [
        editor?.document.uri.toString() || 'no-editor',
        input.mode,
        identity?.name?.toUpperCase() || candidateSql.slice(0, 160),
        JSON.stringify(input.callArguments || [])
    ].join('|');
}
