export interface SqliteExplainRow {
    id: number;
    parent: number;
    detail: string;
}

export function parseSqliteExplainPlan(text: string): SqliteExplainRow[] {
    const rows: SqliteExplainRow[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const parts = trimmed.split(/\t+/);
        if (parts.length < 4) {
            continue;
        }
        const id = Number(parts[0]);
        const parent = Number(parts[1]);
        if (!Number.isInteger(id) || !Number.isInteger(parent)) {
            continue;
        }
        rows.push({ id, parent, detail: parts.slice(3).join('\t').trim() });
    }
    return rows;
}

export function normalizeSqliteExplainPlan(text: string): string {
    const rows = parseSqliteExplainPlan(text);
    if (rows.length === 0) {
        return text;
    }

    const depths = new Map<number, number>();
    const lines: string[] = [];
    for (const row of rows) {
        const depth = row.parent < 0 ? 0 : (depths.get(row.parent) ?? 0) + 1;
        depths.set(row.id, depth);
        const indent = '   '.repeat(depth);
        // The generic plan view expects a cost/rows envelope. SQLite does not
        // expose those values in EXPLAIN QUERY PLAN, so use neutral values.
        lines.push(`${indent}${row.detail} (cost=0..0 rows=0 width=0 conf=1)`);
    }
    return lines.join('\n');
}
