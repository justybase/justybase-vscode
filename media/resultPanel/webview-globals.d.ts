/** TanStack Virtual UMD global loaded by the result panel webview. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const VirtualCore: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const TanStackTableCore: any;

interface TableRowModelGetter {
    (): { rows: unknown[] };
}

interface TableRowModelFactory {
    (): TableRowModelGetter;
}

interface TableStateUpdater<T> {
    (updater: T | ((prev: T) => T)): void;
}

interface TableCreateOptions {
    data: unknown[][];
    columns: unknown[];
    state: Record<string, unknown>;
    onSortingChange?: TableStateUpdater<unknown>;
    onGlobalFilterChange?: TableStateUpdater<unknown>;
    onColumnFiltersChange?: TableStateUpdater<unknown>;
    onGroupingChange?: TableStateUpdater<unknown>;
    onExpandedChange?: TableStateUpdater<unknown>;
    onColumnOrderChange?: TableStateUpdater<unknown>;
    onColumnPinningChange?: TableStateUpdater<unknown>;
    onColumnVisibilityChange?: TableStateUpdater<unknown>;
    globalFilterFn?: (row: unknown, columnId: string, filterValue: string) => boolean;
    getCoreRowModel: TableRowModelGetter;
    getSortedRowModel: TableRowModelGetter;
    getFilteredRowModel: TableRowModelGetter;
    getGroupedRowModel: TableRowModelGetter;
    getExpandedRowModel: TableRowModelGetter;
}

interface TableCoreModule {
    createTable: (options: TableCreateOptions) => unknown;
    getCoreRowModel: TableRowModelFactory;
    getSortedRowModel: TableRowModelFactory;
    getFilteredRowModel: TableRowModelFactory;
    getGroupedRowModel: TableRowModelFactory;
    getExpandedRowModel: TableRowModelFactory;
}

declare const TableCore: TableCoreModule;

interface HTMLDivElement {
    _scrollSaveTimeout?: ReturnType<typeof setTimeout>;
}

interface GridRowVirtualizer {
    options: { count: number; overscan?: number; estimateSize?: () => number };
    _didMount(): () => void;
    _willUpdate(): void;
    getVirtualItems(): Array<{ index: number; start: number; size: number; end: number }>;
    getTotalSize(): number;
    scrollToIndex(index: number, options?: { align?: string }): void;
    measureElement?(element: Element): void;
    getMaxScrollOffset?(): number;
    measure?(): void;
    onTableRowsRendered?: (callback: () => void) => void;
}

interface HTMLInputElement {
    value: string;
}
