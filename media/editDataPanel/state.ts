/**
 * Pure editing model for the Edit Data panel.
 *
 * The model owns the loaded rows, the pending change set (updates, inserts,
 * deletes) and the client-side view order. It has no DOM dependencies so the
 * transitions can be unit tested directly.
 */
import type { EditDataChanges, EditDataColumnMetadata, EditDataRow } from './hostContracts.js';

export type ValueFamily = 'number' | 'text' | 'date' | 'bool' | 'other';

export interface GridColumn {
    name: string;
    /** Declared SQL type (FORMAT_TYPE) when metadata is available. */
    type: string;
    family: ValueFamily;
    isPk: boolean;
    isFk: boolean;
    notNull: boolean;
    comment: string;
    readonly: boolean;
}

export type RowStatus = 'clean' | 'new' | 'deleted';

export interface WorkingRow {
    /** Stable identity: `r:<ROWID>` for loaded rows, `n:<id>` for inserted rows. */
    key: string;
    rowId: string | number | null;
    original: Record<string, unknown> | null;
    values: Record<string, unknown>;
    status: RowStatus;
    modified: Set<string>;
}

export type SortDirection = 'asc' | 'desc';

export interface EditorState {
    columns: GridColumn[];
    rows: Map<string, WorkingRow>;
    /** Keys in display order. */
    order: string[];
    /** Keys in load order, used to restore the order when sorting is cleared. */
    loadOrder: string[];
    sort: { column: string; direction: SortDirection } | null;
    nextInsertId: number;
}

export interface ChangeSummary {
    modifiedRows: number;
    modifiedCells: number;
    inserted: number;
    deleted: number;
    total: number;
}

const ROWID = 'ROWID';

export function classifyType(formatType: string | undefined): ValueFamily {
    const t = (formatType || '').trim().toUpperCase();
    if (!t) return 'other';
    if (/^(BOOL|BOOLEAN)\b/.test(t)) return 'bool';
    if (/^(BYTEINT|SMALLINT|INT|INTEGER|BIGINT|INT[1248]|NUMERIC|DECIMAL|NUMBER|REAL|FLOAT|DOUBLE)\b/.test(t)) return 'number';
    if (/^(DATE|TIME|TIMESTAMP|INTERVAL|TIMETZ|DATETIME)\b/.test(t)) return 'date';
    if (/^(CHAR|CHARACTER|VARCHAR|NCHAR|NVARCHAR|TEXT|STRING|CLOB|JSON|VARBINARY|ST_GEOMETRY)\b/.test(t)) return 'text';
    return 'other';
}

/** Four-letter header badge, matching the Results grid convention (INTE, VARC, ...). */
export function typeBadge(formatType: string | undefined): string {
    const t = (formatType || '').trim().toUpperCase();
    if (!t) return '';
    const base = t.split(/[\s(]/)[0] || t;
    return base.slice(0, 4);
}

function isTruthyFlag(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

export function buildColumns(columnNames: string[], metadata: EditDataColumnMetadata[] | undefined): GridColumn[] {
    const byName = new Map<string, EditDataColumnMetadata>();
    (metadata || []).forEach(meta => byName.set(String(meta.ATTNAME).toUpperCase(), meta));
    return columnNames.map(name => {
        const meta = byName.get(name.toUpperCase());
        const isRowId = name.toUpperCase() === ROWID;
        const type = isRowId ? 'ROWID' : String(meta?.FORMAT_TYPE || '');
        return {
            name,
            type,
            family: isRowId ? 'number' : classifyType(type),
            isPk: isTruthyFlag(meta?.IS_PK),
            isFk: isTruthyFlag(meta?.IS_FK),
            notNull: isTruthyFlag(meta?.IS_NOT_NULL),
            comment: String(meta?.DESCRIPTION || ''),
            readonly: isRowId,
        };
    });
}

function rowKeyFor(row: EditDataRow, fallbackIndex: number): string {
    const rowId = row.ROWID;
    return rowId === null || rowId === undefined ? `x:${fallbackIndex}` : `r:${String(rowId)}`;
}

export function createState(data: EditDataRow[], columnNames: string[], metadata?: EditDataColumnMetadata[]): EditorState {
    const rows = new Map<string, WorkingRow>();
    const order: string[] = [];
    data.forEach((row, index) => {
        let key = rowKeyFor(row, index);
        if (rows.has(key)) key = `x:${index}`;
        const original = { ...row };
        rows.set(key, {
            key,
            rowId: row.ROWID ?? null,
            original,
            values: { ...row },
            status: 'clean',
            modified: new Set(),
        });
        order.push(key);
    });
    return {
        columns: buildColumns(columnNames, metadata),
        rows,
        order,
        loadOrder: [...order],
        sort: null,
        nextInsertId: 1,
    };
}

/** Empty input is persisted as NULL by the host, so the model treats it as NULL too. */
export function normalizeEditedValue(value: unknown): unknown {
    if (value === undefined || value === '') return null;
    return value;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
    const na = normalizeEditedValue(a);
    const nb = normalizeEditedValue(b);
    if (na === nb) return true;
    if (na === null || nb === null) return false;
    return String(na) === String(nb);
}

function getColumn(state: EditorState, name: string): GridColumn | undefined {
    return state.columns.find(c => c.name === name);
}

export function isEditableColumn(state: EditorState, name: string): boolean {
    const column = getColumn(state, name);
    return Boolean(column && !column.readonly);
}

/** Applies an edit and returns true when the row's pending state changed. */
export function setCellValue(state: EditorState, key: string, column: string, value: unknown): boolean {
    const row = state.rows.get(key);
    if (!row || row.status === 'deleted' || !isEditableColumn(state, column)) return false;
    const next = normalizeEditedValue(value);
    const before = row.values[column];
    row.values[column] = next;

    if (row.status === 'new') {
        return !valuesEqual(before, next);
    }

    const original = row.original ? row.original[column] : null;
    const wasModified = row.modified.has(column);
    if (valuesEqual(next, original)) {
        row.values[column] = original;
        row.modified.delete(column);
    } else {
        row.modified.add(column);
    }
    return wasModified !== row.modified.has(column) || !valuesEqual(before, next);
}

export function revertCell(state: EditorState, key: string, column: string): boolean {
    const row = state.rows.get(key);
    if (!row || row.status !== 'clean' || !row.modified.has(column) || !row.original) return false;
    row.values[column] = row.original[column];
    row.modified.delete(column);
    return true;
}

/** Reverts every pending change on the row; inserted rows are removed. */
export function revertRow(state: EditorState, key: string): boolean {
    const row = state.rows.get(key);
    if (!row) return false;
    if (row.status === 'new') {
        removeRow(state, key);
        return true;
    }
    const changed = row.status === 'deleted' || row.modified.size > 0;
    if (row.original) row.values = { ...row.original };
    row.modified.clear();
    row.status = 'clean';
    return changed;
}

export function revertAll(state: EditorState): void {
    [...state.rows.keys()].forEach(key => revertRow(state, key));
}

function removeRow(state: EditorState, key: string): void {
    state.rows.delete(key);
    state.order = state.order.filter(k => k !== key);
    state.loadOrder = state.loadOrder.filter(k => k !== key);
}

/**
 * Toggles deletion for the given rows. When any row is not yet marked, all are
 * marked; otherwise all are restored. Inserted rows are discarded immediately.
 */
export function toggleDelete(state: EditorState, keys: string[]): void {
    const rows = keys.map(k => state.rows.get(k)).filter((r): r is WorkingRow => Boolean(r));
    const markAll = rows.some(r => r.status !== 'deleted');
    rows.forEach(row => {
        if (row.status === 'new') {
            removeRow(state, row.key);
        } else if (markAll) {
            if (row.original) row.values = { ...row.original };
            row.modified.clear();
            row.status = 'deleted';
        } else {
            row.status = 'clean';
        }
    });
}

/** Inserts a blank (or copied) row after the given display index and returns its key. */
export function insertRow(state: EditorState, afterIndex: number, template?: Record<string, unknown>): string {
    const key = `n:${state.nextInsertId++}`;
    const values: Record<string, unknown> = {};
    state.columns.forEach(column => {
        if (column.readonly) return;
        values[column.name] = template ? normalizeEditedValue(template[column.name]) : null;
    });
    state.rows.set(key, { key, rowId: null, original: null, values, status: 'new', modified: new Set() });
    const position = Math.max(0, Math.min(state.order.length, afterIndex + 1));
    state.order.splice(position, 0, key);
    if (state.sort) {
        // Sorted views keep inserted rows on top; load order mirrors that.
        state.loadOrder.unshift(key);
    } else {
        state.loadOrder.splice(position, 0, key);
    }
    return key;
}

export function duplicateRow(state: EditorState, key: string): string | null {
    const row = state.rows.get(key);
    if (!row) return null;
    const index = state.order.indexOf(key);
    return insertRow(state, index, row.values);
}

export function summarizeChanges(state: EditorState): ChangeSummary {
    let modifiedRows = 0;
    let modifiedCells = 0;
    let inserted = 0;
    let deleted = 0;
    state.rows.forEach(row => {
        if (row.status === 'new') inserted++;
        else if (row.status === 'deleted') deleted++;
        else if (row.modified.size > 0) {
            modifiedRows++;
            modifiedCells += row.modified.size;
        }
    });
    return { modifiedRows, modifiedCells, inserted, deleted, total: modifiedRows + inserted + deleted };
}

export function hasPendingChanges(state: EditorState): boolean {
    return summarizeChanges(state).total > 0;
}

/**
 * Numeric columns edited as text are sent as numbers when the conversion is
 * lossless, so the host emits `BALANCE = 12.5` instead of a quoted literal.
 */
export function coerceForColumn(value: unknown, column: GridColumn | undefined): unknown {
    if (column?.family !== 'number' || typeof value !== 'string') return value;
    const text = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) return value;
    const parsed = Number(text);
    return Number.isFinite(parsed) && String(parsed) === text ? parsed : value;
}

/** Serializes pending changes in the shape the host save handler expects. */
export function buildChanges(state: EditorState): EditDataChanges {
    const updates: { rowId: string | number; changes: Record<string, unknown> }[] = [];
    const deletes: (string | number)[] = [];
    const inserts: Record<string, unknown>[] = [];

    state.loadOrder.forEach(key => {
        const row = state.rows.get(key);
        if (!row) return;
        if (row.status === 'new') {
            const insert: Record<string, unknown> = {};
            state.columns.forEach(column => {
                if (column.readonly) return;
                const value = row.values[column.name];
                if (value !== null && value !== undefined) insert[column.name] = coerceForColumn(value, column);
            });
            inserts.push(insert);
        } else if (row.status === 'deleted') {
            if (row.rowId !== null) deletes.push(row.rowId);
        } else if (row.modified.size > 0 && row.rowId !== null) {
            const changes: Record<string, unknown> = {};
            row.modified.forEach(column => {
                changes[column] = coerceForColumn(row.values[column], getColumn(state, column));
            });
            updates.push({ rowId: row.rowId, changes });
        }
    });

    return { updates, deletes, inserts };
}

function compareValues(a: unknown, b: unknown, family: ValueFamily): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
    if (family === 'number') {
        const na = Number(a);
        const nb = Number(b);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Cycles sorting for a column: ascending → descending → load order. */
export function cycleSort(state: EditorState, column: string): void {
    if (!state.sort || state.sort.column !== column) {
        state.sort = { column, direction: 'asc' };
    } else if (state.sort.direction === 'asc') {
        state.sort = { column, direction: 'desc' };
    } else {
        state.sort = null;
    }
    applySort(state);
}

export function applySort(state: EditorState): void {
    if (!state.sort) {
        state.order = [...state.loadOrder];
        return;
    }
    const { column, direction } = state.sort;
    const family = getColumn(state, column)?.family ?? 'other';
    const factor = direction === 'asc' ? 1 : -1;
    // Inserted rows stay on top so new input is never sorted out of view.
    const fresh = state.loadOrder.filter(k => state.rows.get(k)?.status === 'new');
    const rest = state.loadOrder.filter(k => state.rows.get(k)?.status !== 'new');
    rest.sort((ka, kb) => {
        const va = state.rows.get(ka)?.values[column];
        const vb = state.rows.get(kb)?.values[column];
        return compareValues(va, vb, family) * factor;
    });
    state.order = [...fresh, ...rest];
}

function sqlLiteral(value: unknown, family: ValueFamily): string {
    if (family === 'number' && typeof value === 'number') return String(value);
    if (family === 'bool' && typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** Builds a WHERE predicate that matches the given cell value ("Filter by value"). */
export function buildValuePredicate(column: GridColumn, value: unknown, identifier: string): string {
    if (value === null || value === undefined) return `${identifier} IS NULL`;
    return `${identifier} = ${sqlLiteral(value, column.family)}`;
}

/** Displays a value the same way the Results grid does for scalar types. */
export function formatDisplayValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}
