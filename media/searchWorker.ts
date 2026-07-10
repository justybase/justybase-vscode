/**
 * Background search worker for large result sets (loaded via blob URL in init.ts).
 */

export {};

interface SearchColumnDef {
    accessorKey?: string | number;
}

interface SearchDataContext {
    data: unknown[];
    columns: SearchColumnDef[];
}

interface SetDataMessage {
    command: 'setData';
    id: number;
    data: unknown[];
    columns: SearchColumnDef[];
}

interface InitDataMessage {
    command: 'initData';
    id: number;
    columns: SearchColumnDef[];
}

interface AppendDataMessage {
    command: 'appendData';
    id: number;
    rows: unknown[];
}

interface SearchMessage {
    command: 'search';
    id: number;
    query?: string;
    seq?: number;
}

interface ClearDataMessage {
    command: 'clearData';
    id: number;
}

type SearchWorkerIncomingMessage =
    | SetDataMessage
    | InitDataMessage
    | AppendDataMessage
    | SearchMessage
    | ClearDataMessage;

type SearchWorkerScope = typeof self & {
    searchData?: Record<number, SearchDataContext>;
    onmessage: ((event: MessageEvent<SearchWorkerIncomingMessage>) => void) | null;
    postMessage: (message: Record<string, unknown>) => void;
};

const workerScope = self as unknown as SearchWorkerScope;

function getCellValue(
    row: unknown,
    columnIndex: number,
    column: SearchColumnDef,
): string {
    let val: unknown;

    if (Array.isArray(row)) {
        val = row[columnIndex];
    } else if (column.accessorKey !== undefined && row && typeof row === 'object') {
        val = (row as Record<string | number, unknown>)[column.accessorKey];
    } else if (row && typeof row === 'object') {
        val = (row as Record<string, unknown>)[String(columnIndex)];
    }

    if (val === null || val === undefined) {
        return 'NULL';
    }

    return String(val);
}

function compactFilterSearchText(value: string): string {
    return String(value).toLowerCase().replace(/[\s\u00A0\u202F,]/g, '');
}

function cellMatchesGlobalFilter(cellText: string, query: string): boolean {
    const lowerCell = cellText.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (lowerCell.includes(lowerQuery)) {
        return true;
    }

    const compactQuery = compactFilterSearchText(query);
    if (!compactQuery) {
        return false;
    }

    return compactFilterSearchText(cellText).includes(compactQuery);
}

function findMatchedIndices(
    rows: unknown[],
    columns: SearchColumnDef[],
    query: string,
): number[] {
    const matchedIndices: number[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        let match = false;

        for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            const column = columns[columnIndex];
            const cellText = getCellValue(row, columnIndex, column);
            if (cellMatchesGlobalFilter(cellText, query)) {
                match = true;
                break;
            }
        }

        if (match) {
            matchedIndices.push(rowIndex);
        }
    }

    return matchedIndices;
}

workerScope.onmessage = function (event: MessageEvent<SearchWorkerIncomingMessage>) {
    const message = event.data;

    if (message.command === 'setData') {
        if (!workerScope.searchData) {
            workerScope.searchData = {};
        }
        workerScope.searchData[message.id] = {
            data: message.data,
            columns: message.columns,
        };
        workerScope.postMessage({ command: 'setDataDone', id: message.id });
        return;
    }

    if (message.command === 'initData') {
        if (!workerScope.searchData) {
            workerScope.searchData = {};
        }
        workerScope.searchData[message.id] = {
            data: [],
            columns: message.columns,
        };
        return;
    }

    if (message.command === 'appendData') {
        const ctx = workerScope.searchData?.[message.id];
        if (ctx && Array.isArray(message.rows) && message.rows.length > 0) {
            ctx.data.push(...message.rows);
        }
        return;
    }

    if (message.command === 'search') {
        const resultId = message.id;
        const searchCtx = workerScope.searchData?.[resultId];

        if (!searchCtx?.data) {
            workerScope.postMessage({
                command: 'searchResult',
                id: resultId,
                matchedIndices: null,
                seq: message.seq,
            });
            return;
        }

        const query = message.query ? String(message.query).toLowerCase() : '';
        if (!query) {
            workerScope.postMessage({
                command: 'searchResult',
                id: resultId,
                matchedIndices: null,
                seq: message.seq,
            });
            return;
        }

        workerScope.postMessage({
            command: 'searchResult',
            id: resultId,
            matchedIndices: findMatchedIndices(
                searchCtx.data,
                searchCtx.columns,
                query,
            ),
            seq: message.seq,
        });
        return;
    }

    if (message.command === 'clearData') {
        if (workerScope.searchData) {
            delete workerScope.searchData[message.id];
        }
    }
};
