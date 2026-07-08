import { getGlobalFilterState, getGrid } from './state.js';
import type { ColumnFilterValue, ConditionColumnFilter, DiskColumnConditionSpec, DiskColumnFilterSpec, DiskQuerySpec, DiskSortSpec, ResultSet, TanStackTable } from './types.js';
import { getActiveSourceUri, getResultSetAt } from './types.js';
import { diskQuerySpecHasFilters, diskQuerySpecIsActive } from './diskQueryUtils.js';

export function getDiskQuerySpec(rsIndex: number): DiskQuerySpec | undefined {
    return getResultSetAt(rsIndex)?.diskQuerySpec;
}

export function setDiskQuerySpec(rsIndex: number, spec: DiskQuerySpec | undefined): void {
    const rs = getResultSetAt(rsIndex);
    if (!rs) {
        return;
    }
    rs.diskQuerySpec = spec;
}

function tanStackToDiskColumnFilter(
    filter: { id: string; value: ColumnFilterValue },
): DiskColumnFilterSpec | undefined {
    const columnIndex = Number.parseInt(filter.id, 10);
    if (Number.isNaN(columnIndex) || columnIndex < 0) {
        return undefined;
    }
    const value = filter.value;
    if (!value) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return { columnIndex, values: value };
    }
    if ((value as ConditionColumnFilter)._isConditionFilter) {
        const cf = value as ConditionColumnFilter;
        return {
            columnIndex,
            conditions: cf.conditions,
            conditionLogic: cf.logic,
        };
    }
    return undefined;
}

function tanStackFiltersToDiskSpec(
    filters: Array<{ id: string; value: ColumnFilterValue }> | undefined,
): DiskColumnFilterSpec[] | undefined {
    if (!filters || filters.length === 0) {
        return undefined;
    }
    const result = filters
        .map(tanStackToDiskColumnFilter)
        .filter((f): f is DiskColumnFilterSpec => f !== undefined);
    return result.length > 0 ? result : undefined;
}

export function buildDiskQuerySpecForResultSet(rsIndex: number): DiskQuerySpec {
    const rs = getResultSetAt(rsIndex);
    const grid = getGrid(rsIndex);
    const table = grid?.tanTable;
    const globalSearch = getGlobalFilterState(
        rsIndex,
        rs?.executionTimestamp,
        getActiveSourceUri(),
    );

    const existing = rs?.diskQuerySpec ?? {};
    const tanStackFilters = table?.getState().columnFilters;

    // Prefer TanStack column filters when present (reflects context menu actions).
    // When TanStack has an empty array, column filters are explicitly cleared.
    // Fall back to existing disk query spec only when TanStack has no filter state.
    const columnFilters = tanStackFilters !== undefined
        ? tanStackFiltersToDiskSpec(tanStackFilters)
        : existing.columnFilters;

    const spec: DiskQuerySpec = {
        globalSearch: globalSearch?.trim() ? globalSearch : undefined,
        columnFilters: columnFilters,
        sorting: buildSortingFromTable(table),
    };
    return spec;
}

export function buildSortingFromTable(table: TanStackTable | undefined): DiskSortSpec[] {
    if (!table?.getState) {
        return [];
    }
    const sorting = table.getState().sorting ?? [];
    return sorting
        .map((entry) => ({
            columnIndex: Number.parseInt(entry.id, 10),
            desc: entry.desc === true,
        }))
        .filter((entry) => Number.isInteger(entry.columnIndex) && entry.columnIndex >= 0);
}

export function syncDiskQuerySpecFromGrid(rsIndex: number): DiskQuerySpec | undefined {
    const spec = buildDiskQuerySpecForResultSet(rsIndex);
    if (diskQuerySpecIsActive(spec)) {
        setDiskQuerySpec(rsIndex, spec);
        return spec;
    }
    setDiskQuerySpec(rsIndex, undefined);
    return undefined;
}

export function setDiskColumnFilterValues(
    rsIndex: number,
    columnIndex: number,
    rawValues: unknown[],
): void {
    const rs = getResultSetAt(rsIndex);
    if (!rs) {
        return;
    }
    const spec = buildDiskQuerySpecForResultSet(rsIndex);
    const filters = [...(spec.columnFilters ?? [])].filter((filter) => filter.columnIndex !== columnIndex);
    if (rawValues.length > 0) {
        filters.push({ columnIndex, values: rawValues });
    }
    spec.columnFilters = filters.length > 0 ? filters : undefined;
    if (diskQuerySpecIsActive(spec)) {
        rs.diskQuerySpec = spec;
    } else {
        rs.diskQuerySpec = undefined;
    }

    // Keep TanStack state in sync so context menu actions work correctly.
    syncColumnFiltersToTanStack(rsIndex, filters);
}

export function setDiskColumnFilterConditions(
    rsIndex: number,
    columnIndex: number,
    conditions: DiskColumnConditionSpec[],
    logic: 'and' | 'or',
): void {
    const rs = getResultSetAt(rsIndex);
    if (!rs) {
        return;
    }
    const spec = buildDiskQuerySpecForResultSet(rsIndex);
    const filters = [...(spec.columnFilters ?? [])].filter((filter) => filter.columnIndex !== columnIndex);
    if (conditions.length > 0) {
        filters.push({ columnIndex, conditions, conditionLogic: logic });
    }
    spec.columnFilters = filters.length > 0 ? filters : undefined;
    if (diskQuerySpecIsActive(spec)) {
        rs.diskQuerySpec = spec;
    } else {
        rs.diskQuerySpec = undefined;
    }

    // Keep TanStack state in sync so context menu actions work correctly.
    syncColumnFiltersToTanStack(rsIndex, filters);
}

/** Keep TanStack column filter state aligned with the disk query spec. */
export function syncColumnFiltersToTanStack(
    rsIndex: number,
    filters: DiskColumnFilterSpec[] | undefined,
): void {
    const table = getGrid(rsIndex)?.tanTable;
    if (!table) {
        return;
    }
    if (!filters || filters.length === 0) {
        const current = table.getState().columnFilters;
        if (current && current.length > 0) {
            table.setColumnFilters([]);
        }
        return;
    }
    // Convert DiskColumnFilterSpec[] back to TanStack format
    const tanStackFilters = filters.map((f) => ({
        id: String(f.columnIndex),
        value: f.conditions
            ? { _isConditionFilter: true, conditions: f.conditions, logic: f.conditionLogic ?? 'and' } as ConditionColumnFilter
            : (f.values ?? []) as unknown as ColumnFilterValue,
    }));
    table.setColumnFilters(tanStackFilters);
}

export function getDiskFilteredCount(rs: ResultSet | undefined): number {
    if (!rs) {
        return 0;
    }
    if (!diskQueryChangesRowCount(rs.diskQuerySpec)) {
        return rs.totalRowCount ?? rs.diskFilteredCount ?? rs.data.length ?? 0;
    }
    if (typeof rs.diskFilteredCount === 'number') {
        return rs.diskFilteredCount;
    }
    return rs.totalRowCount ?? rs.data.length ?? 0;
}

/** Keep disk row-count fields aligned while streaming (before filters/sort are active). */
export function syncDiskStreamingRowCount(rs: ResultSet, totalRows: number): void {
    rs.totalRowCount = totalRows;
    if (!diskQueryChangesRowCount(rs.diskQuerySpec)) {
        rs.diskFilteredCount = totalRows;
    }
}

export function diskQueryChangesRowCount(spec: DiskQuerySpec | undefined): boolean {
    return diskQuerySpecHasFilters(spec);
}
