import { describe, expect, it } from '@jest/globals';
import { forEachWithYield, yieldToEventLoop } from '../../metadata/hydrateScheduler';

describe('hydrateScheduler', () => {
    it('yieldToEventLoop resolves', async () => {
        await expect(yieldToEventLoop()).resolves.toBeUndefined();
    });

    it('forEachWithYield processes all items', async () => {
        const seen: number[] = [];
        await forEachWithYield([1, 2, 3, 4, 5], 2, (item) => {
            seen.push(item);
        });
        expect(seen).toEqual([1, 2, 3, 4, 5]);
    });

    it('forEachWithYield handles empty input', async () => {
        const seen: number[] = [];
        await forEachWithYield([], 5, (item) => {
            seen.push(item);
        });
        expect(seen).toEqual([]);
    });

    it('forEachWithYield does not yield after the final batch when length is batch-aligned', async () => {
        let yieldCount = 0;
        const originalSetImmediate = global.setImmediate;
        global.setImmediate = ((callback: () => void) => {
            yieldCount += 1;
            return originalSetImmediate(callback);
        }) as typeof setImmediate;

        try {
            const seen: number[] = [];
            await forEachWithYield([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, (item) => {
                seen.push(item);
            });
            expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            expect(yieldCount).toBe(1);
        } finally {
            global.setImmediate = originalSetImmediate;
        }
    });
});
