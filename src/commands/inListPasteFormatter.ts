import type { SqlTypeFamily } from '../sqlParser/visitor/typeComparisonUtils';

export type InListPasteType = SqlTypeFamily;

export interface InListPasteFormatOptions {
    type?: InListPasteType;
}

/**
 * Formats one-column, line-separated clipboard data for an empty IN list.
 * The function deliberately returns undefined when the input cannot be safely
 * represented as a list of the requested type.
 */
export function formatInListPaste(
    pastedText: string,
    options: InListPasteFormatOptions = {},
): string | undefined {
    if (!pastedText.includes('\n')) {
        return undefined;
    }

    let lines = pastedText.replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    if (lines.length < 2 || lines.some((line) => line.includes('\t'))) {
        return undefined;
    }

    const markdownRows = parseSingleColumnMarkdownTable(lines);
    if (markdownRows) {
        lines = markdownRows;
    }

    const family = options.type ?? 'numeric';
    const formatted = family === 'string' || family === 'datetime'
        ? lines.map((line) => `'${line.replace(/'/g, "''")}'`)
        : lines.map((line) => line.replace(/\s/g, '').replace(',', '.'));

    if (family === 'numeric' || family === 'unknown') {
        const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
        if (!formatted.every((line) => numeric.test(line))) {
            return undefined;
        }
    }

    if (family === 'boolean') {
        return undefined;
    }

    return formatted.join('\n,');
}

/**
 * Recognizes only a one-column Markdown table. A multi-column table is left to
 * the regular import flow instead of being mistaken for a value list.
 */
function parseSingleColumnMarkdownTable(lines: string[]): string[] | undefined {
    if (!isMarkdownSeparator(lines[1]!)) {
        return undefined;
    }

    const dataRows = lines.slice(2);
    if (dataRows.length < 1) {
        return undefined;
    }

    const values: string[] = [];
    for (const row of dataRows) {
        const trimmedRow = row.trim();
        if (!trimmedRow.startsWith('|') || !trimmedRow.endsWith('|')) {
            return undefined;
        }
        const cells = trimmedRow.slice(1, -1).split('|');
        if (cells.length !== 1) {
            return undefined;
        }
        values.push(cells[0]!.trim());
    }
    return values;
}

function isMarkdownSeparator(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
        return false;
    }
    const cells = trimmed.slice(1, -1).split('|');
    return cells.length === 1 && /^\s*:?-{3,}:?\s*$/.test(cells[0]!);
}
