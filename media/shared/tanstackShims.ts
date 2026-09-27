/**
 * Minimal TanStack Table / Virtualizer shapes shared across webview modules.
 */

export interface TanStackCellContext<T = unknown> {
    getValue: () => T;
    row: {
        original: unknown;
        index: number;
    };
}

export interface TanStackVirtualItem {
    index: number;
    start: number;
    end: number;
    size: number;
}

export interface TanStackVirtualizerLike {
    getVirtualItems: () => TanStackVirtualItem[];
    getTotalSize: () => number;
    _didMount: () => void;
    _willUpdate: () => void;
}

export interface TanStackHeaderLike {
    column: {
        id: string;
        columnDef: {
            header?: string;
            cell?: (info: TanStackCellContext) => Node | string;
        };
    };
    getSize: () => number;
}

export interface TanStackHeaderGroupLike {
    headers: TanStackHeaderLike[];
}

export interface TanStackVisibleCellLike {
    column: {
        id: string;
        columnDef: {
            cell?: (info: TanStackCellContext) => Node | string;
        };
    };
    getContext: () => TanStackCellContext;
}

export interface TanStackRowLike<T = unknown> {
    original: T;
    index: number;
    getVisibleCells: () => TanStackVisibleCellLike[];
}

export interface TanStackTableLike<T = unknown> {
    getHeaderGroups: () => TanStackHeaderGroupLike[];
    getRowModel: () => { rows: TanStackRowLike<T>[] };
}

interface TanStackDataTableLike {
    setOptions?: (updater: (previous: Record<string, unknown>) => Record<string, unknown>) => void;
    options?: Record<string, unknown>;
}

/** Update v9's readonly data option through its supported options API. */
export function setTanStackTableData(table: TanStackDataTableLike, data: unknown[]): void {
    if (table.setOptions) {
        table.setOptions(previous => ({ ...previous, data }));
        return;
    }

    // Keep simple pre-v9 test doubles working; production v9 tables always
    // take the setOptions branch above.
    if (table.options) {
        table.options.data = data;
    }
}
