import { describe, expect, it } from '@jest/globals';
import {
    resetMetadataQueryLimiterForTests,
    runWithMetadataQueryConcurrencyLimit,
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
        expect(maxInFlight).toBe(5);

        while (release.length > 0) {
            release.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        await Promise.all(tasks);
        expect(maxInFlight).toBe(5);
        expect(inFlight).toBe(0);
    });
});
