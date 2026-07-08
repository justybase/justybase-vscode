import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { exportStructuredToXlsb } from '../export/xlsbExporter';

export interface StashedResult {
    columns: string[];
    rows: unknown[][];
    totalRows: number;
    limitReached: boolean;
    recordsAffected: number | undefined;
    sql: string;
}

const stash = new Map<string, StashedResult>();
const cellResultMap = new Map<string, string>(); // cellUri -> resultId
const _onDidChangeCellResults = new vscode.EventEmitter<void>();
export const onDidChangeCellResults = _onDidChangeCellResults.event;

export function stashResult(id: string, result: StashedResult): void {
    stash.set(id, result);
}

export function mapCellResult(cellUri: string, resultId: string): void {
    cellResultMap.set(cellUri, resultId);
    _onDidChangeCellResults.fire();
}

export function getCellResultId(cellUri: string): string | undefined {
    return cellResultMap.get(cellUri);
}

export function getStashedResult(): Record<string, StashedResult>;
export function getStashedResult(id: string): StashedResult | undefined;
export function getStashedResult(id?: string): StashedResult | Record<string, StashedResult> | undefined {
    if (id) return stash.get(id);
    const all: Record<string, StashedResult> = {};
    for (const [k, v] of stash) all[k] = v;
    return all;
}

export function getLastStashedResult(): StashedResult | undefined {
    let last: StashedResult | undefined;
    for (const [, v] of stash) last = v;
    return last;
}

export class FullGridPanel {
    private _panel: vscode.WebviewPanel;

    constructor(
        private _extensionUri: vscode.Uri,
        result: StashedResult,
    ) {
        this._panel = vscode.window.createWebviewPanel(
            'justybase.fullGrid',
            'JustyBase — Full Results Grid',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'media'),
                    vscode.Uri.joinPath(this._extensionUri, 'dist', 'media'),
                ],
            },
        );

        this._panel.webview.html = buildHtml(result);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'exportXlsb') {
                await this._exportXlsb(result);
            }
        });
    }

    public reveal(): void {
        this._panel.reveal();
    }

    private async _exportXlsb(result: StashedResult): Promise<void> {
        const timestamp = Date.now();
        const defaultPath = path.join(os.homedir(), 'Desktop', `netezza_export_${timestamp}.xlsb`);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultPath),
            filters: { 'Excel Binary Workbook (*.xlsb)': ['xlsb'] },
            title: 'Save XLSB Export',
        });
        if (!uri) return;

        try {
            const resultItem = {
                columns: result.columns.map((name) => ({ name, type: undefined, scale: undefined })),
                rows: result.rows,
                name: 'Results',
            };
            await exportStructuredToXlsb([resultItem], uri.fsPath, false);
            const open = await vscode.window.showInformationMessage(
                `Exported ${result.rows.length} rows to XLSB.`,
                'Open File',
            );
            if (open === 'Open File') {
                await vscode.env.openExternal(uri);
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`XLSB export failed: ${msg}`);
        }
    }
}

function escapeHtml(value: unknown): string {
    if (value === null || value === undefined) return '<span class="null">NULL</span>';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildHtml(result: StashedResult): string {
    const { columns, rows, limitReached, recordsAffected, sql } = result;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>JustyBase Results</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-editor-font-family,Menlo,Monaco,Consolas,monospace);font-size:12px;color:var(--vscode-editor-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e);padding:8px;overflow:hidden;display:flex;flex-direction:column;height:100vh}
.toolbar{display:flex;gap:8px;align-items:center;padding:4px 0 8px;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border,#444);margin-bottom:4px}
.toolbar button,.toolbar input{padding:4px 10px;font-size:12px;border-radius:3px;border:1px solid var(--vscode-panel-border,#555);background:var(--vscode-button-secondaryBackground,#333);color:var(--vscode-button-secondaryForeground,#ddd);cursor:pointer}
.toolbar button:hover{background:var(--vscode-button-secondaryHoverBackground,#444)}
.toolbar input{flex:1;min-width:150px;background:var(--vscode-input-background,#252525);color:var(--vscode-input-foreground,#ccc)}
.toolbar input::placeholder{color:var(--vscode-input-placeholderForeground,#666)}
.stats{padding:4px 0;color:var(--vscode-descriptionForeground,#888);flex-shrink:0;white-space:nowrap}
.container{flex:1;overflow:auto;position:relative}
table{border-collapse:collapse;width:max-content;min-width:100%}
thead th{position:sticky;top:0;z-index:2;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);border:1px solid var(--vscode-panel-border,#555);padding:6px 10px;text-align:left;white-space:nowrap;font-weight:600;cursor:pointer;user-select:none}
thead th:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
thead th.sorted-asc::after{content:" ▲";font-size:10px}
thead th.sorted-desc::after{content:" ▼";font-size:10px}
thead th.row-num{padding:4px 6px;text-align:right;min-width:40px;cursor:default}
tbody td{border:1px solid var(--vscode-panel-border,#444);padding:2px 10px;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis}
tbody td.row-num{padding:2px 6px;text-align:right;color:var(--vscode-descriptionForeground,#888);font-size:11px}
tbody tr:nth-child(even){background:var(--vscode-textBlockQuote-background,rgba(128,128,128,0.04))}
tbody tr:nth-child(even) td{background:inherit}
.null{color:var(--vscode-descriptionForeground,#808080);font-style:italic}
.hidden{display:none!important}
.sql-preview{flex-shrink:0;padding:8px 0;border-top:1px solid var(--vscode-panel-border,#444);margin-top:8px}
.sql-preview pre{font-size:11px;color:var(--vscode-descriptionForeground,#888);white-space:pre-wrap;word-break:break-all;max-height:80px;overflow-y:auto}
</style>
</head>
<body>
<div class="toolbar">
    <input type="text" id="filter" placeholder="Filter rows..." oninput="applyFilter()">
    <button onclick="requestXlsb()" title="Export to Excel Binary Workbook">📥 Export to XLSB</button>
    <button onclick="clearFilter()">✕ Clear</button>
    <span style="margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground,#888)">Click column header to sort</span>
</div>
<div class="stats" id="stats"></div>
<div class="container" id="grid"></div>
<div class="sql-preview"><pre>${escapeHtml(sql)}</pre></div>
<script>
const COLUMNS = ${JSON.stringify(columns)};
const ROWS = ${JSON.stringify(rows)};
const LIMIT_REACHED = ${limitReached};
const RECORDS_AFFECTED = ${recordsAffected !== undefined ? recordsAffected : 'undefined'};

let currentSort = { col: -1, desc: false };
let filterText = '';

var api = null;
try { api = acquireVsCodeApi(); } catch(e) {}

function requestXlsb() {
    if (api) {
        api.postMessage({ command: 'exportXlsb' });
    } else {
        // fallback: show message
        document.getElementById('stats').textContent = 'Export not available in this context.';
    }
}

function applyFilter() {
    filterText = document.getElementById('filter').value.toLowerCase().trim();
    renderTable();
}

function clearFilter() {
    document.getElementById('filter').value = '';
    filterText = '';
    renderTable();
}

function sortBy(colIdx) {
    if (currentSort.col === colIdx) {
        currentSort.desc = !currentSort.desc;
    } else {
        currentSort.col = colIdx;
        currentSort.desc = false;
    }
    renderTable();
}

function renderTable() {
    var visible = ROWS.filter(function(row) {
        if (!filterText) return true;
        for (var i = 0; i < row.length; i++) {
            var v = row[i];
            if (v !== null && v !== undefined && String(v).toLowerCase().indexOf(filterText) !== -1) {
                return true;
            }
        }
        return false;
    });

    if (currentSort.col >= 0) {
        visible.sort(function(a, b) {
            var av = a[currentSort.col];
            var bv = b[currentSort.col];
            if (av === bv) return 0;
            if (av === null || av === undefined) return currentSort.desc ? -1 : 1;
            if (bv === null || bv === undefined) return currentSort.desc ? 1 : -1;
            if (typeof av === 'number' && typeof bv === 'number') return currentSort.desc ? bv - av : av - bv;
            var cmp = String(av).localeCompare(String(bv));
            return currentSort.desc ? -cmp : cmp;
        });
    }

    var html = '<table>';
    html += '<thead><tr><th class="row-num">#</th>';
    for (var c = 0; c < COLUMNS.length; c++) {
        var cls = currentSort.col === c ? (currentSort.desc ? 'sorted-desc' : 'sorted-asc') : '';
        html += '<th class="' + cls + '" onclick="sortBy(' + c + ')">' + esc(COLUMNS[c]) + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var r = 0; r < visible.length; r++) {
        var row = visible[r];
        html += '<tr><td class="row-num">' + (r + 1) + '</td>';
        for (var c2 = 0; c2 < COLUMNS.length; c2++) {
            var val = c2 < row.length ? row[c2] : null;
            html += '<td>' + esc(val) + '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';

    document.getElementById('grid').innerHTML = html;

    var stats = visible.length + ' row(s)';
    if (visible.length !== ROWS.length) stats += ' (filtered from ' + ROWS.length + ')';
    if (LIMIT_REACHED) stats += ' | row limit reached';
    if (RECORDS_AFFECTED !== 'undefined') stats += ' | Records affected: ' + RECORDS_AFFECTED;
    stats += ' | ' + COLUMNS.length + ' column(s)';
    document.getElementById('stats').textContent = stats;
}

function esc(v) {
    if (v === null || v === undefined) return '<span class="null">NULL</span>';
    var s = String(v);
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

renderTable();
</script>
</body></html>`;
}
