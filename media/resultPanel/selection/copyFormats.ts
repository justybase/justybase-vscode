/**
 * "Copy as" text formats that need typed values (JSON, SQL INSERT).
 * Tabbed, CSV, Markdown and HTML are rendered from display text in clipboard.ts.
 */

export interface CopyFormatCell {
    text: string;
    kind: 'text' | 'number' | 'date';
    numericValue?: string;
    rawValue?: unknown;
}

export interface CopyFormatTarget {
    db?: string;
    schema?: string;
    table: string;
}

/** Placeholder used when the result does not come from a single editable table. */
export const INSERT_TARGET_PLACEHOLDER = 'TARGET_TABLE';

function isNullCell(cell: CopyFormatCell): boolean {
    return cell.rawValue === null || cell.rawValue === undefined;
}

/** Raw value as text, independent of grid display formatting (thousand separators, locale dates). */
function rawText(cell: CopyFormatCell): string {
    const raw = cell.rawValue;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') return String(raw);
    if (raw instanceof Date) return raw.toISOString();
    if (raw && typeof raw === 'object') {
        try {
            return JSON.stringify(raw);
        } catch {
            return cell.text;
        }
    }
    return cell.text;
}

function jsonValue(cell: CopyFormatCell): unknown {
    if (isNullCell(cell)) return null;
    if (typeof cell.rawValue === 'boolean') return cell.rawValue;
    if (cell.kind === 'number' && cell.numericValue !== undefined) {
        const parsed = Number(cell.numericValue);
        // Keep the exact digits as a string when a JS number would round them (big DECIMAL/BIGINT).
        return Number.isFinite(parsed) && String(parsed) === cell.numericValue ? parsed : cell.numericValue;
    }
    return rawText(cell);
}

/** Array of row objects keyed by column header; duplicate headers get a numeric suffix. */
export function formatCellsAsJson(headers: string[], rows: CopyFormatCell[][]): string {
    const keys = uniqueKeys(headers);
    const objects = rows.map(row => {
        const entry: Record<string, unknown> = {};
        keys.forEach((key, index) => {
            const cell = row[index];
            entry[key] = cell ? jsonValue(cell) : null;
        });
        return entry;
    });
    return JSON.stringify(objects, null, 2);
}

function uniqueKeys(headers: string[]): string[] {
    const seen = new Map<string, number>();
    return headers.map((header, index) => {
        const base = header || `column_${index + 1}`;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}_${count + 1}`;
    });
}

/** Simple identifiers stay bare so the statement fits any dialect's case folding. */
function sqlIdentifier(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(cell: CopyFormatCell): string {
    if (isNullCell(cell)) return 'NULL';
    if (typeof cell.rawValue === 'boolean') return cell.rawValue ? 'TRUE' : 'FALSE';
    if (cell.kind === 'number' && cell.numericValue !== undefined) return cell.numericValue;
    return `'${rawText(cell).replace(/'/g, "''")}'`;
}

export function insertTargetName(target: CopyFormatTarget | null | undefined): string {
    if (!target?.table) return INSERT_TARGET_PLACEHOLDER;
    const parts = [target.db, target.schema, target.table].filter((part): part is string => Boolean(part?.trim()));
    return parts.map(sqlIdentifier).join('.');
}

export function formatCellsAsInsert(
    headers: string[],
    rows: CopyFormatCell[][],
    target?: CopyFormatTarget | null,
): string {
    const tableName = insertTargetName(target);
    const columnList = headers.map(sqlIdentifier).join(', ');
    return rows
        .map(row => `INSERT INTO ${tableName} (${columnList}) VALUES (${row.map(sqlLiteral).join(', ')});`)
        .join('\n');
}

/** Values per line once an IN list no longer fits comfortably on one line. */
const IN_LIST_VALUES_PER_LINE = 10;

/**
 * `IN (...)` predicate list from the selected cells (row-major), ready to paste
 * into a WHERE clause: numbers stay bare, text is quoted with `'` doubled,
 * NULLs are skipped (`col IN (NULL)` never matches) and duplicates removed.
 */
export function formatCellsAsInList(rows: CopyFormatCell[][]): string {
    const literals: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        for (const cell of row) {
            if (!cell || isNullCell(cell)) continue;
            const literal = sqlLiteral(cell);
            if (seen.has(literal)) continue;
            seen.add(literal);
            literals.push(literal);
        }
    }
    if (literals.length === 0) {
        return 'IN (NULL)';
    }
    if (literals.length <= IN_LIST_VALUES_PER_LINE) {
        return `IN (${literals.join(', ')})`;
    }
    const lines: string[] = [];
    for (let index = 0; index < literals.length; index += IN_LIST_VALUES_PER_LINE) {
        lines.push(`    ${literals.slice(index, index + IN_LIST_VALUES_PER_LINE).join(', ')}`);
    }
    return `IN (\n${lines.join(',\n')}\n)`;
}
