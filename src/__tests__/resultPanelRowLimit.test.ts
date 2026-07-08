jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn(),
    formatSqlIdentifierForInsertion: jest.fn((value: string) => value)
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    savePinnedState: jest.fn()
}));

jest.mock('../../media/resultPanel/formatting.js', () => ({
    openResultFormattingPanel: jest.fn()
}));

jest.mock('../../media/resultPanel/rangeChart.js', () => ({
    closeRangeChartModal: jest.fn(),
    openRangeChartModal: jest.fn()
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
    getHostState: jest.fn(() => undefined),
    setHostState: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    getGrid: jest.fn(() => null),
    getIsSearching: jest.fn(() => false),
    getGlobalFilterState: jest.fn(() => ''),
    getSortedSearchMatchIndices: jest.fn(() => undefined)
}));

describe('result panel row limit helpers', () => {
    beforeEach(() => {
        jest.resetModules();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                queryRowLimit: 200000,
                resultSets: [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: new Array(200000).fill([1]),
                        limitReached: false
                    }
                ]
            }
        });
    });

    it('detects row limit from fetched row count even when limitReached flag is false', () => {
        const filterModule: {
            isResultSetRowLimitReached: (rs: { data: unknown[][]; limitReached?: boolean }) => boolean;
        } = require('../../media/resultPanel/filter.js');

        const rs = (window as unknown as { resultSets: Array<{ data: unknown[][]; limitReached?: boolean }> }).resultSets[0];
        expect(filterModule.isResultSetRowLimitReached(rs)).toBe(true);
    });

    it('keeps limit reached visible in row count after renderRowCountInfo', () => {
        const appendedChildren: Array<{ className?: string }> = [];
        const container = {
            innerHTML: '',
            textContent: '',
            style: { opacity: '' },
            appendChild: jest.fn((node: { className?: string }) => {
                appendedChildren.push(node);
            })
        };
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'rowCountInfo' ? container : null)),
                createTextNode: jest.fn((text: string) => ({ nodeType: 3, textContent: text })),
                createElement: jest.fn((tag: string) => ({
                    tagName: tag.toUpperCase(),
                    className: '',
                    title: '',
                    textContent: ''
                }))
            }
        });

        const filterModule: {
            applyRowLimitReachedFlag: (rs: { limitReached?: boolean; data: unknown[][] }, limitReached: boolean) => void;
            renderRowCountInfo: (index: number) => void;
        } = require('../../media/resultPanel/filter.js');

        const rs = (window as unknown as { resultSets: Array<{ limitReached?: boolean; data: unknown[][] }> }).resultSets[0];
        filterModule.applyRowLimitReachedFlag(rs, false);
        filterModule.renderRowCountInfo(0);

        expect(rs.limitReached).toBe(true);
        expect(appendedChildren.some(node => node.className === 'row-limit-warning')).toBe(true);
    });
});
