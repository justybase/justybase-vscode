/**
 * Yield helpers for chunked metadata hydration off the critical path.
 */

export const METADATA_HYDRATE_BATCH_SIZE = 100;

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

export async function forEachWithYield<T>(
    items: readonly T[],
    batchSize: number,
    fn: (item: T) => void,
): Promise<void> {
    if (items.length === 0) {
        return;
    }

    for (let index = 0; index < items.length; index++) {
        fn(items[index]);
        const processed = index + 1;
        if (processed % batchSize === 0 && processed < items.length) {
            await yieldToEventLoop();
        }
    }
}
