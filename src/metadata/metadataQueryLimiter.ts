/** Max concurrent metadata (_V_*) queries per logical connection name. */
const MAX_CONCURRENT_METADATA_QUERIES = 5;

/** @internal Test / diagnostics */
export function getMetadataQueryConcurrencyLimit(): number {
    return MAX_CONCURRENT_METADATA_QUERIES;
}

interface ConnectionLimiterState {
    active: number;
    queue: Array<() => void>;
}

const limiters = new Map<string, ConnectionLimiterState>();

function normalizeConnectionName(connectionName: string): string {
    return connectionName.toUpperCase();
}

function getLimiterState(connectionName: string): ConnectionLimiterState {
    const key = normalizeConnectionName(connectionName);
    let state = limiters.get(key);
    if (!state) {
        state = { active: 0, queue: [] };
        limiters.set(key, state);
    }
    return state;
}

function drainQueue(state: ConnectionLimiterState): void {
    // Wake at most one waiter per completion; waiters increment `active` asynchronously.
    if (state.active < MAX_CONCURRENT_METADATA_QUERIES && state.queue.length > 0) {
        const next = state.queue.shift();
        next?.();
    }
}

/**
 * Limit parallel metadata catalog queries per connection (shared across tabs/features).
 */
export async function runWithMetadataQueryConcurrencyLimit<T>(
    connectionName: string,
    operation: () => Promise<T>,
): Promise<T> {
    const state = getLimiterState(connectionName);

    if (state.active >= MAX_CONCURRENT_METADATA_QUERIES) {
        await new Promise<void>((resolve) => {
            state.queue.push(resolve);
        });
    }

    state.active += 1;
    try {
        return await operation();
    } finally {
        state.active -= 1;
        drainQueue(state);
    }
}

/** @internal Test helper */
export function resetMetadataQueryLimiterForTests(): void {
    limiters.clear();
}
