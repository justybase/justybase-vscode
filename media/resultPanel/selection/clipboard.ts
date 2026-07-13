import { postHostMessage } from '../protocol.js';
import {
    escapeCsvValue,
    formatCellValue,
    getNumericTypeInfo,
    isTemporalType,
} from '../utils.js';
import type {
    ResultColumnDef,
    TanStackColumn,
    TanStackRow,
    TanStackTable,
} from '../types.js';

const vscode = { postMessage: postHostMessage };
function getVisibleDataColumns(table: TanStackTable): TanStackColumn[] {
    return table.getVisibleLeafColumns().filter(col => !col.columnDef?.isRowNumber);
}

function getFormattedClipboardCellValue(row: TanStackRow, col: TanStackColumn): string | null {
    const cellValue = row.getValue(col.id);
    if (cellValue === null || cellValue === undefined) {
        return 'NULL';
    }

    return formatCellValue(cellValue, col.columnDef.dataType, col.columnDef.scale, {
        columnId: col.id,
        inferredNumericKind: col.columnDef.inferredNumericKind,
        inferredDateInteger: col.columnDef.inferredDateInteger
    });
}

function isClipboardNumericColumn(columnDef: ResultColumnDef | undefined): boolean {
    if (columnDef?.inferredNumericKind === 'decimal' || columnDef?.inferredNumericKind === 'integer') {
        return true;
    }

    const { isNumeric } = getNumericTypeInfo(columnDef?.dataType);
    return isNumeric;
}

function normalizeExcelNumericValue(value: unknown): string | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : null;
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    if (/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return trimmed;
    }

    return null;
}

function getLocaleDecimalSeparator() {
    try {
        const formatter = new Intl.NumberFormat();
        const parts = formatter.formatToParts(1.1);
        const decimalPart = parts.find(part => part.type === 'decimal');
        return decimalPart?.value || '.';
    } catch {
        return '.';
    }
}

export function localizeNumericDisplayText(text: string): string {
    const decimalSeparator = getLocaleDecimalSeparator();
    if (decimalSeparator === '.' || typeof text !== 'string' || text.includes(',')) {
        return text;
    }

    const trimmed = text.trim();
    if (!trimmed.includes('.')) {
        return text;
    }

    const compact = trimmed.replace(/\s+/g, '');
    if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(compact)) {
        return text;
    }

    return text.replace('.', decimalSeparator);
}

function getClipboardCellPayload(row: TanStackRow, col: TanStackColumn): ClipboardCellPayload {
    const textValue = getFormattedClipboardCellValue(row, col);
    const text = textValue === null || typeof textValue === 'undefined' ? '' : String(textValue);
    const rawValue = row.getValue(col.id);
    const columnDef = col.columnDef || {};

    if (rawValue === null || rawValue === undefined) {
        return { text, htmlValue: text, kind: 'text' };
    }

    if (isClipboardNumericColumn(columnDef)) {
        const numericValue = normalizeExcelNumericValue(rawValue);
        if (numericValue !== null) {
            return {
                text,
                htmlValue: localizeNumericDisplayText(text),
                kind: 'number',
                numericValue
            };
        }
    }

    if (columnDef.inferredDateInteger || isTemporalType(columnDef.dataType)) {
        return { text, htmlValue: text, kind: 'date' };
    }

    return { text, htmlValue: text, kind: 'text' };
}

function getClipboardColumnAlignment(columnDef: ResultColumnDef | undefined): string {
    if (columnDef?.inferredNumericKind === 'decimal' || columnDef?.inferredNumericKind === 'integer') {
        return 'left';
    }

    if (columnDef?.inferredDateInteger) {
        return 'left';
    }

    const { isNumeric } = getNumericTypeInfo(columnDef?.dataType);
    if (isNumeric || isTemporalType(columnDef?.dataType)) {
        return 'left';
    }

    return 'right';
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

interface ClipboardCellPayload {
    text: string;
    htmlValue: string;
    kind: 'text' | 'number' | 'date';
    numericValue?: string;
}

function createPlainTextTable(headers: string[], rows: ClipboardCellPayload[][]) {
    const lines: string[] = [];
    if (headers.length > 0) {
        lines.push(headers.join('\t'));
    }
    rows.forEach(row => {
        lines.push(row.map(cell => cell.text).join('\t'));
    });
    return lines.join('\n');
}

function createHtmlTable(
    headers: string[],
    rows: ClipboardCellPayload[][],
    alignments: string[],
): string {
    const tableStyle = [
        'border-collapse:collapse',
        'border-spacing:0',
        'font-family:Calibri, Arial, sans-serif',
        'font-size:11pt',
        'line-height:1.4',
        'color:#1f1f1f'
    ].join(';');
    const headerStyle = [
        'background-color:#f3f2f1',
        'border:1px solid #d1d1d1',
        'padding:6px 8px',
        'font-weight:600',
        'text-align:left',
        'vertical-align:top',
        'white-space:nowrap'
    ].join(';');

    const theadHtml = headers.length > 0
        ? `<thead><tr>${headers.map(header => `<th align="left" style="${headerStyle}">${escapeHtml(header)}</th>`).join('')}</tr></thead>`
        : '';

    const tbodyHtml = rows.map((row, rowIndex) => {
        const rowBackground = rowIndex % 2 === 0 ? '#ffffff' : '#faf9f8';
        const cellsHtml = row.map((cell, cellIndex) => {
            const alignment = alignments[cellIndex] || 'left';
            const cellStyle = [
                `border:1px solid #d1d1d1`,
                'padding:6px 8px',
                `text-align:${alignment}`,
                'vertical-align:top',
                `background-color:${rowBackground}`,
                'white-space:nowrap'
            ];
            
            if (cell.kind === 'text') {
                cellStyle.push(`mso-number-format:'\\@'`);
            }
            
            const numericAttribute = cell.kind === 'number' && cell.numericValue
                ? ` x:num="${escapeHtml(cell.numericValue)}"`
                : '';
            return `<td align="${alignment}" style="${cellStyle.join(';')}"${numericAttribute}>${escapeHtml(cell.htmlValue)}</td>`;
        }).join('');
        return `<tr>${cellsHtml}</tr>`;
    }).join('');

    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body><table style="${tableStyle}">${theadHtml}<tbody>${tbodyHtml}</tbody></table></body></html>`;
}

function createMarkdownTable(headers: string[], rows: ClipboardCellPayload[][], alignments: string[]) {
    if (rows.length === 0) return '';
    const lines: string[] = [];
    
    // Default headers if not provided
    const effectiveHeaders = headers.length > 0 ? headers : rows[0].map(() => '');
    
    // Add header row
    lines.push('| ' + effectiveHeaders.map(h => String(h).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')).join(' | ') + ' |');
    
    // Add separator row
    const separator = alignments.map(align => {
        if (align === 'right') return '---:';
        if (align === 'center') return ':---:';
        return '---';
    });
    lines.push('| ' + separator.join(' | ') + ' |');
    
    // Add data rows
    rows.forEach(row => {
        lines.push('| ' + row.map(cell => {
            let content = cell.text;
            if (content === null || content === undefined) content = '';
            return String(content).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
        }).join(' | ') + ' |');
    });
    
    return lines.join('\n');
}

function createCsvTable(headers: string[], rows: ClipboardCellPayload[][], separator = ',') {
    const csvRows: string[] = [];
    const swapDecimal = separator === ';';
    if (headers.length > 0) {
        csvRows.push(headers.map(h => escapeCsvValue(h, separator)).join(separator));
    }
    rows.forEach(row => {
        csvRows.push(row.map(cell => {
            let val = cell.text;
            if (swapDecimal && cell.kind === 'number' && val.indexOf('.') !== -1) {
                val = val.replace('.', ',');
            }
            return escapeCsvValue(val, separator);
        }).join(separator));
    });
    return csvRows.join('\n');
}

export interface ClipboardRowResolver {
    resolveRowValues?: (virtualRowIndex: number) => unknown[] | undefined;
    fetchRowValues?: (virtualRowIndex: number) => Promise<unknown[] | undefined>;
    fetchAllRowValues?: () => Promise<unknown[][]>;
    /** True when the TanStack model holds only the current disk-backed window. */
    isDiskBacked?: boolean;
    queryAggregations?: (aggregations: Array<{ columnIndex: number; fn: string }>) => Promise<Array<{ columnIndex: number; fn: string; value: unknown }>>;
}

function getRawValueFromRowArray(rowValues: unknown[], columnId: string): unknown {
    const columnIndex = Number.parseInt(columnId, 10);
    if (!Number.isInteger(columnIndex) || columnIndex < 0) {
        return undefined;
    }
    return rowValues[columnIndex];
}

function getClipboardCellPayloadFromValues(
    rowValues: unknown[],
    col: TanStackColumn,
): ClipboardCellPayload {
    const rawValue = getRawValueFromRowArray(rowValues, col.id);
    const columnDef = col.columnDef || {};
    const textValue = rawValue === null || rawValue === undefined
        ? 'NULL'
        : formatCellValue(rawValue, columnDef.dataType, columnDef.scale, {
            columnId: col.id,
            inferredNumericKind: columnDef.inferredNumericKind,
            inferredDateInteger: columnDef.inferredDateInteger,
        });
    const text = textValue === null || textValue === undefined ? '' : String(textValue);

    if (rawValue === null || rawValue === undefined) {
        return { text, htmlValue: text, kind: 'text' };
    }

    if (isClipboardNumericColumn(columnDef)) {
        const numericValue = normalizeExcelNumericValue(rawValue);
        if (numericValue !== null) {
            return {
                text,
                htmlValue: localizeNumericDisplayText(text),
                kind: 'number',
                numericValue,
            };
        }
    }

    if (columnDef.inferredDateInteger || isTemporalType(columnDef.dataType)) {
        return { text, htmlValue: text, kind: 'date' };
    }

    return { text, htmlValue: text, kind: 'text' };
}

async function resolveRowValuesForClipboard(
    virtualRowIndex: number,
    table: TanStackTable,
    resolver?: ClipboardRowResolver,
): Promise<unknown[] | undefined> {
    const resolved = resolver?.resolveRowValues?.(virtualRowIndex);
    if (Array.isArray(resolved)) {
        return resolved;
    }
    if (resolver?.fetchRowValues) {
        const fetched = await resolver.fetchRowValues(virtualRowIndex);
        if (Array.isArray(fetched)) {
            return fetched;
        }
    }
    const row = table.getRowModel().rows[virtualRowIndex];
    if (row) {
        return row.original as unknown[];
    }
    return undefined;
}

export async function buildSelectedClipboardPayloadAsync(
    table: TanStackTable,
    selectedCells: Set<string>,
    withHeaders = false,
    resolver?: ClipboardRowResolver,
) {
    const columns = getVisibleDataColumns(table);
    const cellArray = Array.from(selectedCells).map(cellId => {
        const [row, col] = cellId.split('-').map(Number);
        return { row, col };
    }).sort((a, b) => a.row - b.row || a.col - b.col);

    if (cellArray.length === 0) {
        return null;
    }

    const minRow = Math.min(...cellArray.map(cell => cell.row));
    const maxRow = Math.max(...cellArray.map(cell => cell.row));
    const minCol = Math.min(...cellArray.map(cell => cell.col));
    const maxCol = Math.max(...cellArray.map(cell => cell.col));
    const selectedColumns = columns.slice(minCol, maxCol + 1);

    const headers = withHeaders ? selectedColumns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = selectedColumns.map(col => getClipboardColumnAlignment(col.columnDef));
    const matrix: ClipboardCellPayload[][] = [];

    for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
        const rowValues = await resolveRowValuesForClipboard(rowIndex, table, resolver);
        if (!rowValues) {
            continue;
        }
        matrix.push(selectedColumns.map(col => getClipboardCellPayloadFromValues(rowValues, col)));
    }

    return {
        headers,
        matrix,
        alignments,
        text: createPlainTextTable(headers, matrix),
        html: createHtmlTable(headers, matrix, alignments),
        md: createMarkdownTable(headers, matrix, alignments),
    };
}

export async function copyAllRowsAsync(
    table: TanStackTable,
    withHeaders: boolean,
    plainTextFormat: string | undefined,
    resolver?: ClipboardRowResolver,
): Promise<void> {
    const columns = getVisibleDataColumns(table);
    const headers = withHeaders ? columns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const allRows = resolver?.fetchAllRowValues
        ? await resolver.fetchAllRowValues()
        : table.getFilteredRowModel().rows.map((row) => row.original as unknown[]);
    const matrix = allRows.map((rowValues) =>
        columns.map((col) => getClipboardCellPayloadFromValues(rowValues, col)),
    );
    const payload = {
        headers,
        matrix,
        alignments,
        text: createPlainTextTable(headers, matrix),
        html: createHtmlTable(headers, matrix, alignments),
        md: createMarkdownTable(headers, matrix, alignments),
    };
    const plainText = resolvePlainText(payload, plainTextFormat);
    writeMultiFormatToClipboard(payload.html, plainText, payload.md, `${allRows.length} rows`);
}

export async function copyAllRowsAsHtmlAsync(
    table: TanStackTable,
    resolver?: ClipboardRowResolver,
): Promise<void> {
    const columns = getVisibleDataColumns(table);
    const headers = columns.map(col => String(col.columnDef.header ?? ''));
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const allRows = resolver?.fetchAllRowValues
        ? await resolver.fetchAllRowValues()
        : table.getFilteredRowModel().rows.map((row) => row.original as unknown[]);
    const matrix = allRows.map((rowValues) =>
        columns.map((col) => getClipboardCellPayloadFromValues(rowValues, col)),
    );
    const html = createHtmlTable(headers, matrix, alignments);
    const text = createPlainTextTable(headers, matrix);
    const md = createMarkdownTable(headers, matrix, alignments);
    writeMultiFormatToClipboard(html, text, md, `${allRows.length} rows`);
}

export async function copyAllRowsAsMdAsync(
    table: TanStackTable,
    withHeaders: boolean,
    resolver?: ClipboardRowResolver,
): Promise<void> {
    const columns = getVisibleDataColumns(table);
    const headers = withHeaders ? columns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const allRows = resolver?.fetchAllRowValues
        ? await resolver.fetchAllRowValues()
        : table.getFilteredRowModel().rows.map((row) => row.original as unknown[]);
    const matrix = allRows.map((rowValues) =>
        columns.map((col) => getClipboardCellPayloadFromValues(rowValues, col)),
    );
    const html = createHtmlTable(headers, matrix, alignments);
    const md = createMarkdownTable(headers, matrix, alignments);
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsCopyPrimed',
        value: false,
    });
    writeMultiFormatToClipboard(html, md, md, `${allRows.length} rows`);
}

export function buildSelectedClipboardPayload(
    table: TanStackTable,
    selectedCells: Set<string>,
    withHeaders = false,
) {
    const columns = getVisibleDataColumns(table);
    const rows = table.getRowModel().rows;
    const cellArray = Array.from(selectedCells).map(cellId => {
        const [row, col] = cellId.split('-').map(Number);
        return { row, col };
    }).sort((a, b) => a.row - b.row || a.col - b.col);

    if (cellArray.length === 0) {
        return null;
    }

    const minRow = Math.min(...cellArray.map(cell => cell.row));
    const maxRow = Math.max(...cellArray.map(cell => cell.row));
    const minCol = Math.min(...cellArray.map(cell => cell.col));
    const maxCol = Math.max(...cellArray.map(cell => cell.col));
    const selectedColumns = columns.slice(minCol, maxCol + 1);

    const headers = withHeaders ? selectedColumns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = selectedColumns.map(col => getClipboardColumnAlignment(col.columnDef));
    const matrix: ClipboardCellPayload[][] = [];

    for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
        const row = rows[rowIndex];
        if (!row) {
            continue;
        }

        const rowValues = selectedColumns.map(col => getClipboardCellPayload(row, col));
        matrix.push(rowValues);
    }

    return {
        headers: headers,
        matrix: matrix,
        alignments: alignments,
        text: createPlainTextTable(headers, matrix),
        html: createHtmlTable(headers, matrix, alignments),
        md: createMarkdownTable(headers, matrix, alignments)
    };
}

export function copyAllRows(
    table: TanStackTable,
    withHeaders: boolean,
    plainTextFormat?: string,
): void {
    const rows = table.getFilteredRowModel().rows;
    // Filter out row number column from columns to copy
    const columns = getVisibleDataColumns(table);
    const headers = withHeaders ? columns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const matrix = rows.map(row => columns.map(col => getClipboardCellPayload(row, col)));

    const payload = {
        headers: headers,
        matrix: matrix,
        alignments: alignments,
        text: createPlainTextTable(headers, matrix),
        html: createHtmlTable(headers, matrix, alignments),
        md: createMarkdownTable(headers, matrix, alignments)
    };
    const plainText = resolvePlainText(payload, plainTextFormat);
    writeMultiFormatToClipboard(payload.html, plainText, payload.md, `${rows.length} rows`);
}

export function copyAllRowsAsHtml(table: TanStackTable): void {
    const rows = table.getFilteredRowModel().rows;
    const columns = getVisibleDataColumns(table);
    const headers = columns.map(col => String(col.columnDef.header ?? ''));
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const matrix = rows.map(row => columns.map(col => getClipboardCellPayload(row, col)));

    const html = createHtmlTable(headers, matrix, alignments);
    const text = createPlainTextTable(headers, matrix);
    const md = createMarkdownTable(headers, matrix, alignments);
    writeMultiFormatToClipboard(html, text, md, `${rows.length} rows`);
}

export function copyAllRowsAsMd(table: TanStackTable, withHeaders: boolean): void {
    const rows = table.getFilteredRowModel().rows;
    const columns = getVisibleDataColumns(table);
    const headers = withHeaders ? columns.map(col => String(col.columnDef.header ?? '')) : [];
    const alignments = columns.map(col => getClipboardColumnAlignment(col.columnDef));
    const matrix = rows.map(row => columns.map(col => getClipboardCellPayload(row, col)));

    const html = createHtmlTable(headers, matrix, alignments);
    const md = createMarkdownTable(headers, matrix, alignments);
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsCopyPrimed',
        value: false
    });
    writeMultiFormatToClipboard(html, md, md, `${rows.length} rows`);
}

interface SelectedClipboardPayload {
    headers: string[];
    matrix: ClipboardCellPayload[][];
    alignments: string[];
    text: string;
    html: string;
    md: string;
}

function writeToClipboard(text: string, description: string): void {
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsCopyPrimed',
        value: false
    });

    writePlainTextToClipboard(text, `Copied ${description} to clipboard`);
}

export function resolvePlainText(payload: SelectedClipboardPayload, plainTextFormat?: string): string {
    if (plainTextFormat === 'csv') {
        return createCsvTable(payload.headers, payload.matrix, ',');
    }
    if (plainTextFormat === 'csv-semicolon') {
        return createCsvTable(payload.headers, payload.matrix, ';');
    }
    if (plainTextFormat === 'tabbed') {
        return payload.text;
    }
    return payload.md; // markdown (default)
}

function writePlainTextToClipboard(text: string, successText: string): void {
    navigator.clipboard.writeText(text).then(() => {
        vscode.postMessage({
            command: 'info',
            text: successText
        });
    }).catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);

        vscode.postMessage({
            command: 'info',
            text: successText
        });
    });
}

export function writeMultiFormatToClipboard(
    html: string,
    plainText: string,
    md: string,
    description: string,
): void {
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsCopyPrimed',
        value: false
    });

    const clipboardSupported = typeof ClipboardItem !== 'undefined'
        && typeof navigator?.clipboard?.write === 'function';

    if (!clipboardSupported) {
        writePlainTextToClipboard(plainText, `Copied ${description} to clipboard`);
        return;
    }

    const clipboardItem = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' })
    });

    navigator.clipboard.write([clipboardItem]).then(() => {
        vscode.postMessage({
            command: 'info',
            text: `Copied ${description} to clipboard`
        });
    }).catch(() => {
        writePlainTextToClipboard(plainText, `Copied ${description} to clipboard`);
    });
}

export const __testHooks = {
    normalizeExcelNumericValue,
    localizeNumericDisplayText,
    getClipboardCellPayload,
    createHtmlTable,
    buildSelectedClipboardPayload
};
