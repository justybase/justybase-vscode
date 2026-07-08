/**
 * Schema Compare View
 * Webview panel for displaying schema comparison results
 */

import * as vscode from 'vscode';
import { TableComparisonResult, ProcedureComparisonResult, DiffStatus } from '../schema/schemaComparer';

export class SchemaCompareView {
    public static currentPanel: SchemaCompareView | undefined;
    public static readonly viewType = 'netezza.schemaCompare';

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(
        extensionUri: vscode.Uri,
        result: TableComparisonResult | ProcedureComparisonResult,
        comparisonType: 'table' | 'procedure'
    ) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        // If we already have a panel, show it
        if (SchemaCompareView.currentPanel) {
            SchemaCompareView.currentPanel._panel.reveal(column);
            SchemaCompareView.currentPanel._update(result, comparisonType);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            SchemaCompareView.viewType,
            'Schema Comparison',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        SchemaCompareView.currentPanel = new SchemaCompareView(panel, extensionUri, result, comparisonType);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        _extensionUri: vscode.Uri,
        result: TableComparisonResult | ProcedureComparisonResult,
        comparisonType: 'table' | 'procedure'
    ) {
        this._panel = panel;

        // Set the webview's initial html content
        this._update(result, comparisonType);

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        SchemaCompareView.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update(result: TableComparisonResult | ProcedureComparisonResult, comparisonType: 'table' | 'procedure') {
        if (comparisonType === 'table') {
            this._panel.title = `Compare: ${(result as TableComparisonResult).source.name} ↔ ${(result as TableComparisonResult).target.name}`;
            this._panel.webview.html = this._getTableComparisonHtml(result as TableComparisonResult);
        } else {
            this._panel.title = `Compare: ${(result as ProcedureComparisonResult).source.name} ↔ ${(result as ProcedureComparisonResult).target.name}`;
            this._panel.webview.html = this._getProcedureComparisonHtml(result as ProcedureComparisonResult);
        }
    }

    private _getStatusIcon(status: DiffStatus): string {
        switch (status) {
            case 'added':
                return '🟢';
            case 'removed':
                return '🔴';
            case 'modified':
                return '🟡';
            case 'unchanged':
                return '⚪';
        }
    }

    private _getStatusClass(status: DiffStatus): string {
        return `status-${status}`;
    }

    private _getTableComparisonHtml(result: TableComparisonResult): string {
        const sourceFullName = `${result.source.database}.${result.source.schema}.${result.source.name}`;
        const targetFullName = `${result.target.database}.${result.target.schema}.${result.target.name}`;

        // Build column rows
        const columnRows = result.columnDiffs
            .map(diff => {
                const sourceCol = diff.sourceColumn;
                const targetCol = diff.targetColumn;
                const changes = diff.changes?.join('<br>') || '';

                return `
                <tr class="${this._getStatusClass(diff.status)}">
                    <td>${this._getStatusIcon(diff.status)}</td>
                    <td><strong>${diff.name}</strong></td>
                    <td>${sourceCol?.fullTypeName || '-'}</td>
                    <td>${targetCol?.fullTypeName || '-'}</td>
                    <td class="changes">${changes}</td>
                </tr>
            `;
            })
            .join('');

        // Build key rows
        const keyRows = result.keyDiffs
            .map(diff => {
                const sourceKey = diff.sourceKey;
                const targetKey = diff.targetKey;
                const changes = diff.changes?.join('<br>') || '';

                return `
                <tr class="${this._getStatusClass(diff.status)}">
                    <td>${this._getStatusIcon(diff.status)}</td>
                    <td><strong>${diff.name}</strong></td>
                    <td>${sourceKey?.type || '-'} (${sourceKey?.columns.join(', ') || '-'})</td>
                    <td>${targetKey?.type || '-'} (${targetKey?.columns.join(', ') || '-'})</td>
                    <td class="changes">${changes}</td>
                </tr>
            `;
            })
            .join('');

        // Distribution comparison
        const distMatch = result.distributionMatch ? '✅ Match' : '❌ Different';
        const orgMatch = result.organizationMatch ? '✅ Match' : '❌ Different';

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Schema Comparison</title>
                <style>
                    ${this._getStyles()}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Table Structure Comparison</h1>
                    
                    <div class="header-info">
                        <div class="source-header">
                            <span class="label">Source:</span>
                            <span class="value">${sourceFullName}</span>
                        </div>
                        <div class="arrow">↔</div>
                        <div class="target-header">
                            <span class="label">Target:</span>
                            <span class="value">${targetFullName}</span>
                        </div>
                    </div>

                    <div class="summary">
                        <h2>Summary</h2>
                        <div class="summary-grid">
                            <div class="summary-item added">🟢 Added: ${result.summary.columnsAdded} columns, ${result.summary.keysAdded} keys</div>
                            <div class="summary-item removed">🔴 Removed: ${result.summary.columnsRemoved} columns, ${result.summary.keysRemoved} keys</div>
                            <div class="summary-item modified">🟡 Modified: ${result.summary.columnsModified} columns, ${result.summary.keysModified} keys</div>
                            <div class="summary-item unchanged">⚪ Unchanged: ${result.summary.columnsUnchanged} columns</div>
                        </div>
                    </div>

                    <div class="section">
                        <h2>Columns</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th width="40">Status</th>
                                    <th>Column Name</th>
                                    <th>Source Type</th>
                                    <th>Target Type</th>
                                    <th>Changes</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${columnRows}
                            </tbody>
                        </table>
                    </div>

                    ${result.keyDiffs.length > 0
                ? `
                    <div class="section">
                        <h2>Keys & Constraints</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th width="40">Status</th>
                                    <th>Key Name</th>
                                    <th>Source</th>
                                    <th>Target</th>
                                    <th>Changes</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${keyRows}
                            </tbody>
                        </table>
                    </div>
                    `
                : ''
            }

                    <div class="section">
                        <h2>Distribution & Organization</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>Property</th>
                                    <th>Source</th>
                                    <th>Target</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td><strong>DISTRIBUTE ON</strong></td>
                                    <td>${result.sourceDistribution.length > 0 ? result.sourceDistribution.join(', ') : 'RANDOM'}</td>
                                    <td>${result.targetDistribution.length > 0 ? result.targetDistribution.join(', ') : 'RANDOM'}</td>
                                    <td>${distMatch}</td>
                                </tr>
                                <tr>
                                    <td><strong>ORGANIZE ON</strong></td>
                                    <td>${result.sourceOrganization.length > 0 ? result.sourceOrganization.join(', ') : '(none)'}</td>
                                    <td>${result.targetOrganization.length > 0 ? result.targetOrganization.join(', ') : '(none)'}</td>
                                    <td>${orgMatch}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </body>
            </html>
        `;
    }

    private _getProcedureComparisonHtml(result: ProcedureComparisonResult): string {
        const sourceFullName = `${result.source.database}.${result.source.schema}.${result.source.name}`;
        const targetFullName = `${result.target.database}.${result.target.schema}.${result.target.name}`;

        // Build diff lines HTML
        const diffLines = result.sourceDiff
            .map(line => {
                let className: string;
                if (line.startsWith('+')) className = 'diff-added';
                else if (line.startsWith('-')) className = 'diff-removed';
                else className = 'diff-unchanged';

                return `<div class="${className}">${this._escapeHtml(line)}</div>`;
            })
            .join('');

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Procedure Comparison</title>
                <style>
                    ${this._getStyles()}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Procedure Comparison</h1>
                    
                    <div class="header-info">
                        <div class="source-header">
                            <span class="label">Source:</span>
                            <span class="value">${sourceFullName}</span>
                        </div>
                        <div class="arrow">↔</div>
                        <div class="target-header">
                            <span class="label">Target:</span>
                            <span class="value">${targetFullName}</span>
                        </div>
                    </div>

                    <div class="section">
                        <h2>Signature Comparison</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>Property</th>
                                    <th>Source</th>
                                    <th>Target</th>
                                    <th>Match</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr class="${result.argumentsMatch ? '' : 'status-modified'}">
                                    <td><strong>Arguments</strong></td>
                                    <td><code>${result.sourceArguments || '(none)'}</code></td>
                                    <td><code>${result.targetArguments || '(none)'}</code></td>
                                    <td>${result.argumentsMatch ? '✅' : '❌'}</td>
                                </tr>
                                <tr class="${result.returnsMatch ? '' : 'status-modified'}">
                                    <td><strong>Returns</strong></td>
                                    <td><code>${result.sourceReturns}</code></td>
                                    <td><code>${result.targetReturns}</code></td>
                                    <td>${result.returnsMatch ? '✅' : '❌'}</td>
                                </tr>
                                <tr class="${result.executeAsOwnerMatch ? '' : 'status-modified'}">
                                    <td><strong>Execute As</strong></td>
                                    <td>${result.sourceExecuteAsOwner ? 'OWNER' : 'CALLER'}</td>
                                    <td>${result.targetExecuteAsOwner ? 'OWNER' : 'CALLER'}</td>
                                    <td>${result.executeAsOwnerMatch ? '✅' : '❌'}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="section">
                        <h2>Source Code ${result.sourceMatch ? '✅ Identical' : '❌ Different'}</h2>
                        ${result.sourceMatch
                ? `
                            <div class="code-block">
                                <pre>${this._escapeHtml(result.sourceCode)}</pre>
                            </div>
                        `
                : `
                            <div class="code-diff">
                                <pre>${diffLines}</pre>
                            </div>
                        `
            }
                    </div>
                </div>
            </body>
            </html>
        `;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private _getStyles(): string {
        return `
            :root {
                --bg-color: var(--vscode-editor-background);
                --fg-color: var(--vscode-editor-foreground);
                --border-color: var(--vscode-widget-border);
                --header-bg: var(--vscode-sideBarSectionHeader-background);
                --added-bg: rgba(40, 167, 69, 0.2);
                --removed-bg: rgba(220, 53, 69, 0.2);
                --modified-bg: rgba(255, 193, 7, 0.2);
            }

            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--fg-color);
                background-color: var(--bg-color);
                margin: 0;
                padding: 20px;
            }

            .container {
                max-width: 1400px;
                margin: 0 auto;
            }

            h1 {
                border-bottom: 1px solid var(--border-color);
                padding-bottom: 10px;
                margin-bottom: 20px;
            }

            h2 {
                font-size: 1.1em;
                margin-top: 25px;
                margin-bottom: 10px;
                color: var(--vscode-textLink-foreground);
            }

            .header-info {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 20px;
                padding: 15px;
                background-color: var(--header-bg);
                border-radius: 6px;
                margin-bottom: 20px;
            }

            .header-info .label {
                font-weight: bold;
                margin-right: 8px;
            }

            .header-info .value {
                font-family: monospace;
                background-color: var(--vscode-textCodeBlock-background);
                padding: 4px 8px;
                border-radius: 4px;
            }

            .arrow {
                font-size: 1.5em;
                color: var(--vscode-charts-blue);
            }

            .summary {
                background-color: var(--header-bg);
                padding: 15px;
                border-radius: 6px;
                margin-bottom: 20px;
            }

            .summary h2 {
                margin-top: 0;
            }

            .summary-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 10px;
            }

            .summary-item {
                padding: 8px;
                border-radius: 4px;
            }

            .summary-item.added { background-color: var(--added-bg); }
            .summary-item.removed { background-color: var(--removed-bg); }
            .summary-item.modified { background-color: var(--modified-bg); }

            table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 20px;
            }

            th, td {
                padding: 10px;
                text-align: left;
                border: 1px solid var(--border-color);
            }

            th {
                background-color: var(--header-bg);
                font-weight: 600;
            }

            tr.status-added {
                background-color: var(--added-bg);
            }

            tr.status-removed {
                background-color: var(--removed-bg);
            }

            tr.status-modified {
                background-color: var(--modified-bg);
            }

            .changes {
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground);
            }

            .code-block, .code-diff {
                background-color: var(--vscode-textCodeBlock-background);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                padding: 15px;
                overflow-x: auto;
            }

            .code-block pre, .code-diff pre {
                margin: 0;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                white-space: pre;
            }

            .diff-added {
                background-color: var(--added-bg);
                color: #28a745;
            }

            .diff-removed {
                background-color: var(--removed-bg);
                color: #dc3545;
            }

            .diff-unchanged {
                color: var(--fg-color);
            }

            code {
                font-family: var(--vscode-editor-font-family);
                background-color: var(--vscode-textCodeBlock-background);
                padding: 2px 6px;
                border-radius: 3px;
            }
        `;
    }
}
