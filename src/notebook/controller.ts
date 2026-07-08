import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { getQueryConfig } from '../core/queryBatchExecutor';
import type { DatabaseConnection } from '../contracts/database';
import { stashResult, mapCellResult } from './fullGridPanel';

const NOTEBOOK_TYPE = 'netezza-sql-notebook';

export class NetezzaSqlNotebookController {
    readonly controller: vscode.NotebookController;
    readonly id = 'netezza-sql-notebook-controller';
    readonly label = 'Netezza SQL';
    readonly supportedLanguages = ['sql'];
    readonly notebookType = NOTEBOOK_TYPE;

    private _executionOrder = 0;
    private _resultIdCounter = 0;

    constructor(
        _context: vscode.ExtensionContext,
        private _connectionManager: ConnectionManager,
    ) {
        this.controller = vscode.notebooks.createNotebookController(
            this.id,
            this.notebookType,
            this.label,
        );

        this.controller.supportedLanguages = this.supportedLanguages;
        this.controller.supportsExecutionOrder = true;
        this.controller.description = 'Execute SQL cells against Netezza databases';
        this.controller.detail = 'JustyBase Netezza SQL Notebook Controller';
        this.controller.executeHandler = this._execute.bind(this);
    }

    dispose(): void {
        this.controller.dispose();
    }

    private async _execute(
        cells: vscode.NotebookCell[],
        _notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController,
    ): Promise<void> {
        for (const cell of cells) {
            await this._executeCell(cell);
        }
    }

    private async _executeCell(cell: vscode.NotebookCell): Promise<void> {
        if (cell.kind === vscode.NotebookCellKind.Markup) {
            return;
        }

        const execution = this.controller.createNotebookCellExecution(cell);
        execution.executionOrder = ++this._executionOrder;
        execution.start(Date.now());

        let connection: DatabaseConnection | undefined;

        try {
            const connectionName = this._connectionManager.getActiveConnectionName();
            if (!connectionName) {
                return this._endWithError(execution, 'No connection selected. Use the status bar or sidebar to connect first.');
            }

            const details = await this._connectionManager.getConnection(connectionName);
            if (!details) {
                return this._endWithError(execution, `Connection "${connectionName}" not found.`);
            }

            const sql = cell.document.getText().trim();
            if (!sql) {
                execution.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('No SQL to execute.', 'text/markdown')])]);
                execution.end(true);
                return;
            }

            const { queryTimeout, rowLimit } = getQueryConfig();

            connection = await createConnectedDatabaseConnectionFromDetails(details);

            const cmd = connection.createCommand(sql);
            if (queryTimeout && queryTimeout > 0) {
                cmd.commandTimeout = queryTimeout;
            }

            if (execution.token.isCancellationRequested) {
                return this._endWithError(execution, 'Cell execution cancelled.');
            }

            const reader = await cmd.executeReader();
            let totalRows = 0;
            const allResultSets: { columns: string[]; rows: unknown[][] }[] = [];

            try {
                do {
                    const columns: string[] = [];
                    const rows: unknown[][] = [];

                    for (let i = 0; i < reader.fieldCount; i++) {
                        columns.push(reader.getName(i));
                    }

                    while (await reader.read()) {
                        if (execution.token.isCancellationRequested) {
                            break;
                        }

                        if (totalRows < rowLimit) {
                            const row: unknown[] = [];
                            for (let i = 0; i < reader.fieldCount; i++) {
                                row.push(reader.getValue(i));
                            }
                            rows.push(row);
                            totalRows++;
                        } else {
                            break;
                        }
                    }

                    if (columns.length > 0 || rows.length > 0) {
                        allResultSets.push({ columns, rows });
                    }

                    if (execution.token.isCancellationRequested) {
                        break;
                    }
                } while (await reader.nextResult());
            } finally {
                await reader.close();
            }

            if (execution.token.isCancellationRequested) {
                return this._endWithError(execution, 'Cell execution cancelled.');
            }

            const recordsAffected = cmd._recordsAffected;
            const outputs: vscode.NotebookCellOutput[] = [];

            if (allResultSets.length === 0) {
                const msg = recordsAffected !== undefined && recordsAffected >= 0
                    ? `Query executed successfully.\n\nRecords affected: **${recordsAffected}**`
                    : 'Query executed successfully.';
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(msg, 'text/markdown'),
                ]));
            }

            for (let setIdx = 0; setIdx < allResultSets.length; setIdx++) {
                const resultSet = allResultSets[setIdx];
                const resultId = `nb_${Date.now()}_${++this._resultIdCounter}`;

                stashResult(resultId, {
                    columns: resultSet.columns,
                    rows: resultSet.rows,
                    totalRows,
                    limitReached: totalRows >= rowLimit,
                    recordsAffected: recordsAffected !== undefined && recordsAffected >= 0 ? recordsAffected : undefined,
                    sql,
                });
                mapCellResult(cell.document.uri.toString(), resultId);

                if (allResultSets.length > 1) {
                    outputs.push(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.text(`**Result set ${setIdx + 1}** (${resultSet.rows.length} rows)`, 'text/markdown'),
                    ]));
                }

                const html = buildResultsHtml(resultSet, totalRows, rowLimit, recordsAffected);
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(html, 'text/html'),
                ]));
            }

            if (recordsAffected !== undefined && recordsAffected >= 0 && allResultSets.length > 0) {
                outputs.push(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.text(`Records affected: **${recordsAffected}**`, 'text/markdown'),
                ]));
            }

            execution.replaceOutput(outputs);
            execution.end(true);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return this._endWithError(execution, message);
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch {
                    // ignore close errors
                }
            }
        }
    }

    private _endWithError(execution: vscode.NotebookCellExecution, message: string): void {
        execution.replaceOutput([
            new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.stderr(message),
                vscode.NotebookCellOutputItem.text(`**Error:** ${message}`, 'text/markdown'),
            ]),
        ]);
        execution.end(false);
    }
}

function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) {
        return '<span class="nb-null">NULL</span>';
    }
    const str = String(value);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildResultsHtml(
    resultSet: { columns: string[]; rows: unknown[][] },
    totalRows: number,
    rowLimit: number,
    recordsAffected: number | undefined,
): string {
    const { columns, rows } = resultSet;
    const displayRows = rows.slice(0, 1000);
    const truncated = rows.length > displayRows.length;

    let html = '<div class="nb-results" style="overflow:auto;max-height:500px;font-size:12px;font-family:Menlo,Monaco,Consolas,monospace;">';
    html += '<table style="border-collapse:collapse;width:max-content;min-width:100%;">';

    html += '<thead><tr>';
    html += '<th style="position:sticky;top:0;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);border:1px solid var(--vscode-panel-border,#555);padding:4px 12px;text-align:left;white-space:nowrap;font-weight:600;">#</th>';
    for (const col of columns) {
        html += `<th style="position:sticky;top:0;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);border:1px solid var(--vscode-panel-border,#555);padding:4px 12px;text-align:left;white-space:nowrap;font-weight:600;">${escapeHtml(col)}</th>`;
    }
    html += '</tr></thead>';

    html += '<tbody>';
    for (let i = 0; i < displayRows.length; i++) {
        const row = displayRows[i];
        const bg = i % 2 === 0 ? 'transparent' : 'var(--vscode-textBlockQuote-background,rgba(128,128,128,0.05))';
        html += `<tr style="background:${bg};">`;
        html += `<td style="border:1px solid var(--vscode-panel-border,#444);padding:2px 8px;white-space:nowrap;color:var(--vscode-descriptionForeground,#888);font-size:11px;text-align:right;">${i + 1}</td>`;
        for (let j = 0; j < columns.length; j++) {
            const val = j < row.length ? row[j] : null;
            if (val === null || val === undefined) {
                html += '<td style="border:1px solid var(--vscode-panel-border,#444);padding:2px 12px;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground,#808080);font-style:italic;">NULL</td>';
            } else {
                html += `<td style="border:1px solid var(--vscode-panel-border,#444);padding:2px 12px;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(val)}</td>`;
            }
        }
        html += '</tr>';
    }
    html += '</tbody>';

    html += '</table>';

    let footer = `<p style="margin:4px 0;color:var(--vscode-descriptionForeground,#888);font-size:11px;">${rows.length} row(s)`;
    if (truncated) {
        footer += ` (showing first ${displayRows.length} of ${rows.length} rows)`;
    }
    if (totalRows >= rowLimit) {
        footer += ` | <em>row limit reached (${rowLimit})</em>`;
    }
    if (recordsAffected !== undefined && recordsAffected >= 0) {
        footer += ` | Records affected: ${recordsAffected}`;
    }
    footer += '</p>';
    html += footer;
    html += '</div>';

    return html;
}
