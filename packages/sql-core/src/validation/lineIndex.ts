/**
 * Immutable line/column index for one SQL text.
 *
 * Validators report positions for potentially thousands of diagnostics. Scanning
 * from offset zero for every diagnostic is quadratic in document size, so the
 * newline offsets are collected once and positions are resolved with a binary
 * search instead.
 */
export interface SqlLineIndex {
    /** 1-based line containing the offset (clamped to the document). */
    lineAt(offset: number): number
    /** 1-based column of the offset inside its line (clamped to the document). */
    columnAt(offset: number): number
    /** Start offset of a 1-based line, clamped to the first/last line. */
    lineStart(line: number): number
    /** Total number of lines; an empty document still has one line. */
    readonly lineCount: number
}

const LINE_FEED = 10;

function clampOffset(offset: number, length: number): number {
    if (Number.isNaN(offset)) {
        return 0;
    }
    return Math.max(0, Math.min(offset, length));
}

export function createSqlLineIndex(sql: string): SqlLineIndex {
    const lineStarts: number[] = [0];
    for (let index = 0; index < sql.length; index += 1) {
        if (sql.charCodeAt(index) === LINE_FEED) {
            lineStarts.push(index + 1);
        }
    }

    const lineCount = lineStarts.length;
    const lineArrayIndexAt = (offset: number): number => {
        let low = 0;
        let high = lineCount - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (lineStarts[middle] <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low;
    };

    return {
        lineAt(offset: number): number {
            return lineArrayIndexAt(clampOffset(offset, sql.length)) + 1;
        },
        columnAt(offset: number): number {
            const safeOffset = clampOffset(offset, sql.length);
            return safeOffset - lineStarts[lineArrayIndexAt(safeOffset)] + 1;
        },
        lineStart(line: number): number {
            const safeLine = Math.max(1, Math.min(Math.trunc(line) || 1, lineCount));
            return lineStarts[safeLine - 1];
        },
        lineCount,
    };
}
