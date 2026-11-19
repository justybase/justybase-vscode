import { decode } from '@msgpack/msgpack';
import { postHostMessage } from '../protocol.js';

/**
 * Explore needs unfiltered sample pages from the host. The shared grid owns its
 * own row-window requests, so Explore uses a distinct request-id range and only
 * claims responses that belong to its own pending set.
 */
let requestIdCounter = Date.now() * 1000;
const pendingRequests = new Map<number, {
    readonly resolve: (rows: unknown[][]) => void;
    readonly reject: (error: Error) => void;
}>();

function decodeRows(rows: unknown): unknown[][] {
    if (rows instanceof Uint8Array || (rows && typeof rows === 'object' && (rows as { data?: number[] }).data instanceof Array)) {
        const rowData = rows as Uint8Array | { data?: number[] };
        const buffer = rowData instanceof Uint8Array ? rowData : new Uint8Array(rowData.data ?? []);
        return decode(buffer) as unknown[][];
    }
    if (Array.isArray(rows)) {
        return rows as unknown[][];
    }
    return [];
}

export function fetchExploreRows(
    sourceUri: string,
    resultSetIndex: number,
    offset: number,
    limit: number,
): Promise<unknown[][]> {
    return new Promise((resolve, reject) => {
        const requestId = ++requestIdCounter;
        pendingRequests.set(requestId, { resolve, reject });
        postHostMessage({
            command: 'requestRows',
            sourceUri,
            resultSetIndex,
            offset,
            limit,
            requestId,
        });
    });
}

/** Returns true when the response belonged to an Explore sample request. */
export function handleExploreRowWindow(message: Record<string, unknown>): boolean {
    const requestId = message.requestId as number | undefined;
    if (requestId === undefined) return false;
    const pending = pendingRequests.get(requestId);
    if (!pending) return false;
    pendingRequests.delete(requestId);
    try {
        pending.resolve(decodeRows(message.rows));
    } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
}

export function clearExploreRowRequests(): void {
    for (const pending of pendingRequests.values()) {
        pending.reject(new Error('Cancelled'));
    }
    pendingRequests.clear();
}
