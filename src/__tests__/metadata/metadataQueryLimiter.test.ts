import { describe, expect, it } from '@jest/globals';
import {
    getMetadataQueryConcurrencyLimit,
    resetMetadataQueryLimiterForTests,
    runWithMetadataQueryConcurrencyLimit,
    setMetadataQueryConcurrencyLimit,
} from '../../metadata/metadataQueryLimiter';

describe('metadataQueryLimiter', () => {
    it('caps concurrent operations per connection name', async () => {
        resetMetadataQueryLimiterForTests();
        let inFlight = 0;
        let maxInFlight = 0;
        const release: Array<() => void> = [];

        const tasks = Array.from({ length: 10 }, () =>
            runWithMetadataQueryConcurrencyLimit('conn-a', async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise<void>((resolve) => {
                    release.push(resolve);
                });
                inFlight -= 1;
            }),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(maxInFlight).toBe(getMetadataQueryConcurrencyLimit());

        while (release.length > 0) {
            release.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        await Promise.all(tasks);
        expect(maxInFlight).toBe(getMetadataQueryConcurrencyLimit());
        expect(inFlight).toBe(0);
    });

    it('honors a configured concurrency limit and resets to the default', async () => {
        resetMetadataQueryLimiterForTests();
        expect(getMetadataQueryConcurrencyLimit()).toBe(5);
        setMetadataQueryConcurrencyLimit(3);
        expect(getMetadataQueryConcurrencyLimit()).toBe(3);

        let inFlight = 0;
        let maxInFlight = 0;
        const release: Array<() => void> = [];

        const tasks = Array.from({ length: 8 }, () =>
            runWithMetadataQueryConcurrencyLimit('conn-b', async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise<void>((resolve) => {
                    release.push(resolve);
                });
                inFlight -= 1;
            }),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(maxInFlight).toBe(3);

        while (release.length > 0) {
            release.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        await Promise.all(tasks);
        expect(inFlight).toBe(0);

        resetMetadataQueryLimiterForTests();
        expect(getMetadataQueryConcurrencyLimit()).toBe(5);
    });

    it('clamps invalid configured limits to at least 1', () => {
        resetMetadataQueryLimiterForTests();
        setMetadataQueryConcurrencyLimit(0);
        expect(getMetadataQueryConcurrencyLimit()).toBe(1);
        setMetadataQueryConcurrencyLimit(-4);
        expect(getMetadataQueryConcurrencyLimit()).toBe(1);
        resetMetadataQueryLimiterForTests();
    });

    it('clamps configured limits above the supported maximum', () => {
        resetMetadataQueryLimiterForTests();
        setMetadataQueryConcurrencyLimit(100);
        expect(getMetadataQueryConcurrencyLimit()).toBe(16);
        setMetadataQueryConcurrencyLimit(NaN);
        expect(getMetadataQueryConcurrencyLimit()).toBe(5);
        resetMetadataQueryLimiterForTests();
    });
});
