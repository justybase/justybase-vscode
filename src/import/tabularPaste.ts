/** Result of the clipboard heuristic used before the editor accepts a paste. */
export interface TabularPasteInfo {
    /** Non-empty lines in the pasted text. */
    lines: number;
    /** Fields per line (tab count + 1). */
    columns: number;
}

const SQL_LINE_START = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|GRANT|REVOKE|CALL|EXECUTE|DECLARE|BEGIN|END|COMMENT)\b/i;

/**
 * Detects spreadsheet-style pasted data: several non-empty lines that all
 * have the same number of tab-separated fields. SQL scripts usually mix
 * indentation and punctuation, so they fail the consistent-tab check.
 */
export function detectTabularPaste(text: string): TabularPasteInfo | null {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized
        .split('\n')
        .map((line) => line.replace(/\s+$/g, ''))
        .filter((line) => line.length > 0);

    if (lines.length < 3) return null;
    if (lines.some((line) => SQL_LINE_START.test(line))) return null;

    let columns = 0;
    for (const line of lines) {
        if (!line.includes('\t')) return null;
        const fields = line.split('\t');
        // Trailing tabs are common in Excel; they still describe the same table.
        let end = fields.length;
        while (end > 0 && fields[end - 1] === '') end -= 1;
        if (end < 2) return null;
        if (columns === 0) {
            columns = end;
        } else {
            // Allow one trailing empty field to vary, but not the table width.
            if (end > columns) return null;
            if (end < columns && fields.slice(end).some((field) => field !== '')) return null;
        }
    }

    if (columns < 2) return null;
    return { lines: lines.length, columns };
}

export function describeTabularPaste(info: TabularPasteInfo): string {
    const lineLabel = info.lines === 1 ? 'line' : 'lines';
    const columnLabel = info.columns === 1 ? 'column' : 'columns';
    return `${info.lines} tab-separated ${lineLabel} with ${info.columns} ${columnLabel}`;
}
