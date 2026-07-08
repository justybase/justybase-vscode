jest.mock('../../media/resultPanel/utils.js', () => ({
    validateRequiredLibraries: jest.fn(),
    formatCellValue: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    getSavedStateFor: jest.fn(),
    saveAllGridStates: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    createHeaderCellWithFilter: jest.fn(),
    reorderColumnsForPinning: jest.fn()
}));

jest.mock('../../media/resultPanel/selection.js', () => ({
    setupCellSelectionEvents: jest.fn(() => ({}))
}));

describe('result panel global filter input state', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    function setDom(input: { value: string }) {
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'globalFilter' ? input : null))
            }
        });
    }

    it('restores the stored filter for an existing result tab', () => {
        const input = { value: '' };
        setDom(input);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///test.sql',
                resultSets: [
                    { executionTimestamp: 111 },
                    { executionTimestamp: 111 }
                ]
            }
        });

        const stateModule: {
            setGlobalFilterState: (rsIndex: number, filterValue: string, executionTimestamp: number, sourceUri: string) => void;
        } = require('../../media/resultPanel/state.js');
        const gridModule: {
            syncGlobalFilterInput: (index?: number) => void;
        } = require('../../media/resultPanel/grid.js');

        stateModule.setGlobalFilterState(0, 'first-filter', 111, 'file:///test.sql');
        stateModule.setGlobalFilterState(1, 'second-filter', 111, 'file:///test.sql');

        gridModule.syncGlobalFilterInput(1);

        expect(input.value).toBe('second-filter');
    });

    it('clears the filter when a new execution timestamp is loaded', () => {
        const input = { value: '' };
        setDom(input);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///test.sql',
                resultSets: [{ executionTimestamp: 111 }]
            }
        });

        const stateModule: {
            setGlobalFilterState: (rsIndex: number, filterValue: string, executionTimestamp: number, sourceUri: string) => void;
        } = require('../../media/resultPanel/state.js');
        const gridModule: {
            syncGlobalFilterInput: (index?: number) => void;
        } = require('../../media/resultPanel/grid.js');

        stateModule.setGlobalFilterState(0, 'old-filter', 111, 'file:///test.sql');
        gridModule.syncGlobalFilterInput(0);
        expect(input.value).toBe('old-filter');

        (global as typeof globalThis & { window: { resultSets: Array<{ executionTimestamp: number }> } }).window.resultSets = [
            { executionTimestamp: 222 }
        ];

        gridModule.syncGlobalFilterInput(0);

        expect(input.value).toBe('');
    });
});
