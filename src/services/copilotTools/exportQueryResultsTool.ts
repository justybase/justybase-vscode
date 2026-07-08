import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface IExportQueryResultsToolParameters {
    sql?: string;
    sqlFilePath?: string;
    format?: 'csv' | 'xlsx' | 'xlsb' | 'parquet';
    outputPath?: string;
    timeoutSeconds?: number;
    source?: 'sql' | 'activeResults';
}

export class ExportQueryResultsTool implements vscode.LanguageModelTool<IExportQueryResultsToolParameters> {
    constructor(private copilotService: CopilotService) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IExportQueryResultsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const format = options.input.format ?? 'csv';
        const desktopSuggestion = path.join(os.homedir(), 'Desktop', `netezza_export.${format}`);
        const editor = vscode.window.activeTextEditor;
        const editorSql = editor
            ? (!editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText())
            : '';
        const previewSql = options.input.sql
            ? options.input.sql.substring(0, 120) + (options.input.sql.length > 120 ? '...' : '')
            : editorSql.substring(0, 120) + (editorSql.length > 120 ? '...' : '');
        const outputInfo = options.input.outputPath
            ? `\nOutput: ${options.input.outputPath}`
            : `\nOutput not provided (suggested folder: ${desktopSuggestion})`;
        const source = options.input.source ?? 'sql';
        const sqlInfo = source === 'activeResults'
            ? '\nSource: active Netezza Results'
            : options.input.sql
                ? '\nSQL source: inline sql parameter'
                : options.input.sqlFilePath
                    ? `\nSQL source file: ${options.input.sqlFilePath}`
                    : '\nSQL not provided (suggested: current selection or active SQL document)';

        return {
            invocationMessage: `Exporting ${source === 'activeResults' ? 'active results' : 'query results'} to ${format.toUpperCase()}...`,
            confirmationMessages: {
                title: 'Export Query Results',
                message: new vscode.MarkdownString(
                    `Export to **${format.toUpperCase()}**?${outputInfo}${sqlInfo}\n\n` +
                    `Follow-up suggestions:\n` +
                    `- Provide destination folder/file (suggested: \`${desktopSuggestion}\`)\n` +
                    `- Provide SQL directly or \`sqlFilePath\`\n` +
                    `- Suggested SQL default: current selection, otherwise active SQL document\n\n` +
                    `\`\`\`sql\n${previewSql || '-- SQL preview unavailable'}\n\`\`\``
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IExportQueryResultsToolParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { sql, format, outputPath, timeoutSeconds, source, sqlFilePath } = options.input;

        const result = await this.copilotService.exportQueryResults(
            sql,
            format,
            outputPath,
            timeoutSeconds,
            source ?? 'sql',
            sqlFilePath
        );
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }
}

import { CopilotService } from '../copilotService';
