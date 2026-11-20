import * as vscode from 'vscode';
import type { CopilotToolService } from './copilotToolService';

export type SqlValidationMode = 'parser' | 'database';

export interface IValidateSqlToolParameters {
    sql: string;
    mode?: SqlValidationMode;
    database?: string;
}

/** Validates SQL offline (parser/linter) or against the database via EXPLAIN. */
export class ValidateSqlTool implements vscode.LanguageModelTool<IValidateSqlToolParameters> {
    constructor(private readonly copilotService: CopilotToolService) { }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IValidateSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const mode = options.input.mode ?? 'parser';
        const sql = options.input.sql ?? '';
        const sqlPreview = sql.length > 200 ? `${sql.slice(0, 199)}…` : sql;

        return {
            invocationMessage: mode === 'database'
                ? 'Validating SQL on the database...'
                : 'Validating SQL syntax...',
            confirmationMessages: {
                title: mode === 'database' ? 'Validate SQL on Database' : 'Validate SQL',
                message: new vscode.MarkdownString(
                    `${mode === 'database' ? 'Validate with a read-only EXPLAIN' : 'Validate syntax of'}:\n\n\`\`\`sql\n${sqlPreview}\n\`\`\``
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const sql = options.input.sql?.trim();
        if (!sql) {
            throw new Error('SQL is required.');
        }
        try {
            const mode = options.input.mode ?? 'parser';
            const result = mode === 'database'
                ? await this.copilotService.validateSqlOnDatabase(sql, options.input.database)
                : await this.copilotService.validateSql(sql);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`SQL validation failed: ${message}`, { cause: error });
        }
    }
}
