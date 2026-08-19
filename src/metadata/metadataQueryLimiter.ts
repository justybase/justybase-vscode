/** Default max concurrent metadata (_V_*) queries per logical connection name. */
const DEFAULT_METADATA_QUERY_CONCURRENCY = 5;

/** Upper bound matching the `justybase.metadata.queryConcurrency` setting maximum. */
export const MAX_METADATA_QUERY_CONCURRENCY = 16;

let metadataQueryConcurrencyLimit = DEFAULT_METADATA_QUERY_CONCURRENCY;

/** Maximum server-side execution time for one metadata catalog query. */
export const METADATA_QUERY_TIMEOUT_SECONDS = 120;

/** @internal Test / diagnostics */
export function getMetadataQueryConcurrencyLimit(): number {
    return metadataQueryConcurrencyLimit;
}

/**
 * Set the max concurrent metadata queries per connection from configuration.
 * The extension host and the LSP server both call this with the value of the
 * `justybase.metadata.queryConcurrency` setting.
 */
export function setMetadataQueryConcurrencyLimit(limit: number): void {
    if (!Number.isFinite(limit)) {
        metadataQueryConcurrencyLimit = DEFAULT_METADATA_QUERY_CONCURRENCY;
        return;
    }
    metadataQueryConcurrencyLimit = Math.min(
        MAX_METADATA_QUERY_CONCURRENCY,
        Math.max(1, Math.floor(limit)),
    );
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
    if (state.active < metadataQueryConcurrencyLimit && state.queue.length > 0) {
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

    if (state.active >= metadataQueryConcurrencyLimit) {
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
    metadataQueryConcurrencyLimit = DEFAULT_METADATA_QUERY_CONCURRENCY;
}
