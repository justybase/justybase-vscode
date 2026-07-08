import type {
    ColumnFilterValue,
    ConditionColumnFilter,
    FilterCondition,
    ResultColumnDef,
    ResultSet,
    TanStackColumn,
    TanStackHeader,
    TanStackRow,
    TanStackTable,
} from '../types.js';

export type ResultSetWithExtras = ResultSet & {
    message?: string;
    rowsAffected?: number;
};

export interface GridColumnDef extends ResultColumnDef {
    id: string;
    accessorFn: (row: unknown) => unknown;
    filterFn: (row: TanStackRow, columnId: string, filterValue: ColumnFilterValue) => boolean;
    sortingFn: SortingFnValue;
}

export type SortingFnValue =
    | 'alphanumeric'
    | ((rowA: TanStackRow, rowB: TanStackRow, columnId: string) => number);

export interface GridVisibleCell {
    column: TanStackColumn;
    getValue: () => unknown;
}

export interface GroupableTanStackRow extends TanStackRow {
    id?: string;
    depth?: number;
    groupingColumnId?: string;
    subRows?: GroupableTanStackRow[];
    getIsGrouped?: () => boolean;
    getIsExpanded?: () => boolean;
    toggleExpanded?: () => void;
    getGroupingValue?: (columnId: string) => unknown;
    getParentRow?: () => GroupableTanStackRow | undefined;
    getVisibleCells: () => GridVisibleCell[];
}

export interface GridTanStackTable extends TanStackTable {
    getHeaderGroups: () => Array<{ headers: TanStackHeader[] }>;
}

export interface GridTableState {
    sorting: Array<{ id: string; desc: boolean }>;
    globalFilter: string;
    grouping: string[];
    expanded: Record<string, boolean>;
    columnOrder: string[] | null;
    columnFilters: Array<{ id: string; value: ColumnFilterValue }>;
    columnPinning: { left: string[]; right: string[] };
    columnVisibility: Record<string, boolean>;
    pinnedColumns: string[];
}

export interface StateCardOptions {
    title: string;
    description?: string;
    hint?: string;
    tone?: string;
}

export interface FormatContext {
    rsIndex: number;
    executionTimestamp?: number;
}

export type ScheduleRenderFn = (options?: { chrome?: boolean }) => void;

export type AggTypeInfo = { isNumeric: boolean; hasDecimal: boolean };

export type CreateTableFn = TableCoreModule['createTable'];
export type RowModelFactoryFn = TableCoreModule['getCoreRowModel'];

export type {
    ColumnFilterValue,
    ConditionColumnFilter,
    FilterCondition,
};
