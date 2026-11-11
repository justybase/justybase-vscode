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
    getDiskBudgetBytes,
    getEffectiveSpillThreshold,
    isDiskBackedResultsAvailable,
    resolveDiskBudgetBytes,
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
            diskBudgetBytes: 2048 * 1024 * 1024,
        });
    });

    it('clamps the disk budget to the supported rails', () => {
        expect(resolveDiskBudgetBytes(1)).toBe(256 * 1024 * 1024);
        expect(resolveDiskBudgetBytes(4096)).toBe(4096 * 1024 * 1024);
        expect(resolveDiskBudgetBytes(99999)).toBe(16384 * 1024 * 1024);
        expect(resolveDiskBudgetBytes(Number.NaN)).toBe(2048 * 1024 * 1024);
    });

    it('falls back to the default budget for partial settings objects', () => {
        expect(getDiskBudgetBytes({
            enabled: true,
            rowThreshold: 500000,
            memoryRowThreshold: 25000,
            insertBatchSize: 50000,
            idleSpillMinutes: 0,
            idleSpillRowThreshold: 10000,
        })).toBe(2048 * 1024 * 1024);
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
