const mockEnforceWhenDiskBacked = jest.fn(() => false);
const mockAvailable = jest.fn(() => true);
const mockTotalDiskBytes = jest.fn(() => 0);
const mockSettings = { enabled: true };

jest.mock('../../../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: jest.fn((key: string, defaultValue: unknown) => (
            key === 'enforceRowLimitWhenDiskBacked'
                ? mockEnforceWhenDiskBacked()
                : defaultValue
        )),
    })),
}));

jest.mock('../../../core/resultDataProvider/diskBackedSettings', () => ({
    getDiskBackedResultsSettings: jest.fn(() => mockSettings),
    getDiskBudgetBytes: jest.fn(() => 2048 * 1024 * 1024),
    isDiskBackedResultsAvailable: jest.fn(() => mockAvailable()),
}));

jest.mock('../../../core/resultDataProvider/diskBackedStoreRegistry', () => ({
    diskBackedStoreRegistry: {
        totalDiskBytes: jest.fn(() => mockTotalDiskBytes()),
    },
}));

import { resolveQueryMaxRows } from '../../../core/resultDataProvider/queryRowLimit';

describe('resolveQueryMaxRows', () => {
    beforeEach(() => {
        mockEnforceWhenDiskBacked.mockReturnValue(false);
        mockAvailable.mockReturnValue(true);
        mockTotalDiskBytes.mockReturnValue(0);
    });

    it('keeps an explicit per-query cap even with disk-backed results available', () => {
        expect(resolveQueryMaxRows(250_000, 10_001)).toBe(10_001);
    });

    it('lifts the configured row cap when results spill to SQLite', () => {
        expect(resolveQueryMaxRows(250_000)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('keeps the configured row cap when disk-backed results are unavailable', () => {
        mockAvailable.mockReturnValue(false);
        expect(resolveQueryMaxRows(250_000)).toBe(250_000);
    });

    it('keeps the configured row cap when the opt-in setting is enabled', () => {
        mockEnforceWhenDiskBacked.mockReturnValue(true);
        expect(resolveQueryMaxRows(250_000)).toBe(250_000);
    });

    it('keeps the configured row cap when the shared disk budget is exhausted', () => {
        mockTotalDiskBytes.mockReturnValue(2048 * 1024 * 1024);
        expect(resolveQueryMaxRows(250_000)).toBe(250_000);
    });
});
