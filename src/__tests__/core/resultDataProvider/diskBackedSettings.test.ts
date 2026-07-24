jest.mock('../../../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => {
            const values: Record<string, unknown> = {
                'diskBackedResults.enabled': true,
                'diskBackedResults.rowThreshold': 500000,
                'diskBackedResults.memoryRowThreshold': 25000,
                'diskBackedResults.insertBatchSize': 50000,
                'diskBackedResults.idleSpillMinutes': 0,
                'diskBackedResults.idleSpillRowThreshold': 10000,
            };
            return values[key] ?? defaultValue;
        }),
    })),
}));

import {
    getDiskBackedResultsSettings,
    getEffectiveSpillThreshold,
    isDiskBackedResultsAvailable,
} from '../../../core/resultDataProvider/diskBackedSettings';

describe('diskBackedSettings', () => {
    it('returns default disk-backed settings', () => {
        expect(getDiskBackedResultsSettings()).toEqual({
            enabled: true,
            rowThreshold: 500000,
            memoryRowThreshold: 25000,
            memoryByteThreshold: 134217728,
            insertBatchSize: 50000,
            idleSpillMinutes: 0,
            idleSpillRowThreshold: 10000,
        });
    });

    it('defaults spill to memoryRowThreshold (25k), independent of webview stream cap', () => {
        expect(getEffectiveSpillThreshold(getDiskBackedResultsSettings())).toBe(25000);
    });

    it('uses the lower configured memory and hard row thresholds for spill', () => {
        expect(getEffectiveSpillThreshold({
            enabled: true,
            rowThreshold: 500000,
            memoryRowThreshold: 10000,
            insertBatchSize: 50000,
            idleSpillMinutes: 0,
            idleSpillRowThreshold: 10000,
        })).toBe(10000);
    });

    it('detects node:sqlite availability', () => {
        expect(typeof isDiskBackedResultsAvailable()).toBe('boolean');
    });
});
