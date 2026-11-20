import * as vscode from 'vscode';
import { formatExecuteStatementResult } from '../../core/assistant/audit';
import { classifySqlStatement, destructiveTarget } from '../../core/assistant/sqlAccess';
import type { CopilotToolService } from './copilotToolService';

export interface IExecuteSqlToolParameters {
    sql: string;
    maxRows?: number;
    timeoutMs?: number;
    database?: string;
    confirm?: string;
}

function summarizeSql(sql: string): string {
    const oneLine = sql.replace(/\s+/gu, ' ').trim();
    return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

/**
 * Single-statement SQL execution for the Copilot surface. Read-only
 * statements run without a prompt; writes and destructive statements require
 * the matching access tier and an explicit VS Code confirmation.
 */
export class ExecuteSqlTool implements vscode.LanguageModelTool<IExecuteSqlToolParameters> {
    constructor(
        private readonly copilotService: CopilotToolService,
        private readonly allowDestructive: boolean,
        private readonly allowWrites: boolean = true,
    ) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExecuteSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const sql = options.input.sql ?? '';
        const classification = classifySqlStatement(sql);
        const database = options.input.database ? ` on **${options.input.database}**` : '';
        if (classification.kind === 'read') {
            return { invocationMessage: `Running read-only query${database}...` };
        }
        if (!this.allowWrites) {
            return { invocationMessage: 'Write access is disabled for JustyBase AI tools.' };
        }
        const destructiveNotice = classification.kind === 'destructive'
            ? '\n\n**This statement is destructive and may drop database objects.**'
            : '\n\n**This statement modifies database data or schema.**';
        return {
            invocationMessage: classification.kind === 'destructive'
                ? `Running destructive statement${database}...`
                : `Executing SQL${database}...`,
            confirmationMessages: {
                title: classification.kind === 'destructive' ? 'Run destructive SQL?' : 'Execute SQL?',
                message: new vscode.MarkdownString(
                    `Run this statement${database}?\n\n\`\`\`sql\n${summarizeSql(sql)}\n\`\`\`${destructiveNotice}`
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const sql = options.input.sql?.trim();
        if (!sql) {
            throw new Error('SQL is required.');
        }
        const classification = classifySqlStatement(sql);
        if (classification.kind === 'write' && !this.allowWrites) {
            throw new Error('Write statements require the "read-write" or "full" access profile in JustyBase AI Tools settings.');
        }
        if (classification.kind === 'destructive') {
            if (!this.allowDestructive) {
                throw new Error('Destructive statements require the "full" access profile in JustyBase AI Tools settings.');
            }
            const target = destructiveTarget(classification.statement);
            const confirm = options.input.confirm?.trim();
            if (!target) {
                throw new Error(
                    'The destructive statement target could not be determined. Use a supported DROP/TRUNCATE/CALL statement or the drop_object tool.'
                );
            }
            if (!confirm) {
                throw new Error(`Destructive statements require confirm equal to "${target}".`);
            }
            if (confirm.toLowerCase() !== target.toLowerCase()) {
                throw new Error(`confirm must equal the object name "${target}".`);
            }
        }
        const result = await this.copilotService.executeSql(classification.statement, {
            maxRows: options.input.maxRows,
            timeoutMs: options.input.timeoutMs,
            database: options.input.database,
            signal: cancellationToAbortSignal(token),
        });
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatExecuteStatementResult(result))
        ]);
    }
}

function cancellationToAbortSignal(token: vscode.CancellationToken): AbortSignal {
    const controller = new AbortController();
    if (token.isCancellationRequested) {
        controller.abort();
    } else {
        const subscription = token.onCancellationRequested(() => controller.abort());
        controller.signal.addEventListener('abort', () => subscription.dispose(), { once: true });
    }
    return controller.signal;
}
