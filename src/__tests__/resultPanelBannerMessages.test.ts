jest.mock('@msgpack/msgpack', () => ({
    decode: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    saveCurrentSourceToCache: jest.fn(),
    getCachedSource: jest.fn(),
    saveScrollStateForSource: jest.fn(),
    getScrollStateFromCache: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getScrollStateFromGlobalCache: jest.fn(),
    setActiveGridIndex: jest.fn(),
    getActiveGridIndex: jest.fn(() => 0),
    getSearchWorker: jest.fn(),
    setSearchMatches: jest.fn(),
    setIsSearching: jest.fn(),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(),
    getColumnFilterState: jest.fn(),
    getAggregationState: jest.fn(),
    getPinnedColumnsState: jest.fn(),
    getResultFormattingState: jest.fn(),
    setResultFormattingPayload: jest.fn(),
    setResultFormattingState: jest.fn()
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn(),
    showError: jest.fn()
}));

jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: jest.fn(),
    switchToResultSet: jest.fn(),
    updateLogsTabSpinner: jest.fn()
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
    updateLoadingState: jest.fn(),
    appendLogRows: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    updateRowCountInfo: jest.fn(),
    applyRowLimitReachedFlag: jest.fn(),
    isResultSetRowLimitReached: jest.fn(() => false),
    renderRowCountInfo: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn()
}));

describe('result panel execution banner messages', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.useRealTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function installBanner() {
        const appliedClasses = new Set<string>();
        const textEl = {
            textContent: ''
        };
        const cancelBtn = {
            style: { display: 'none' as string }
        };
        const banner = {
            className: '',
            style: { display: '' },
            title: '',
            classList: {
                add: (...classes: string[]) => {
                    classes.forEach(className => appliedClasses.add(className));
                    banner.className = Array.from(appliedClasses).join(' ');
                }
            }
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => {
                    if (id === 'executionStatusBanner') return banner;
                    if (id === 'executionStatusBannerText') return textEl;
                    if (id === 'executionStatusBannerCancel') return cancelBtn;
                    return null;
                })
            }
        });

        return { banner, textEl, cancelBtn };
    }

    it('hides the banner for successful executions so logs remain the completion surface', () => {
        const { banner, textEl } = installBanner();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///reports/monthly_sales.sql',
                executingSources: new Set(),
                resultSets: [
                    { isLog: false, data: [] }
                ]
            }
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();

        expect(banner.style.display).toBe('none');
        expect(textEl.textContent).toBe('');
    });

    it('also hides the banner for untitled successful executions', () => {
        const { banner, textEl } = installBanner();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'untitled:Untitled-1',
                executingSources: new Set(),
                resultSets: [
                    { isLog: false, data: Array.from({ length: 123 }, () => [1]) }
                ]
            }
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();

        expect(banner.style.display).toBe('none');
        expect(textEl.textContent).toBe('');
    });

    it('surfaces partial-results guidance for cancelled executions', () => {
        const { banner, textEl } = installBanner();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/cancel_me.sql',
                executingSources: new Set(),
                resultSets: [
                    { isLog: false, isCancelled: true, data: [[1], [2], [3]] }
                ]
            }
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();

        expect(textEl.textContent).toContain('cancel_me.sql: cancelled');
        expect(textEl.textContent).toContain('Partial results retained: 3 rows');
        expect(banner.title).toContain('Partial rows are still available');
    });

    it('shows a cancel action while a query is still running after the delay', () => {
        jest.useFakeTimers();
        const { banner, textEl, cancelBtn } = installBanner();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'untitled:Untitled-1',
                executingSources: new Set(['untitled:Untitled-1']),
                resultSets: [
                    { isLog: false, data: [[1], [2]] }
                ]
            }
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();

        expect(banner.style.display).toBe('none');
        expect(textEl.textContent).toBe('');

        jest.advanceTimersByTime(5000);

        expect(textEl.textContent).toContain('Untitled query: running...');
        expect(cancelBtn.style.display).toBe('');
    });

    it('does not flash the running banner for queries that finish within 5 seconds', () => {
        jest.useFakeTimers();
        const { banner, textEl } = installBanner();
        const windowState = {
            activeSource: 'untitled:Untitled-1',
            executingSources: new Set(['untitled:Untitled-1']),
            resultSets: [
                { isLog: false, data: [[1], [2]] }
            ]
        };
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: windowState
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();
        expect(banner.style.display).toBe('none');

        windowState.executingSources = new Set();
        windowState.resultSets = [
            { isLog: false, data: [[1], [2], [3]] }
        ];
        messagesModule.updateExecutionStatusBanner();

        jest.advanceTimersByTime(10_000);
        expect(banner.style.display).toBe('none');
        expect(textEl.textContent).toBe('');
    });

    it('surfaces partial-results guidance for error executions with retained rows', () => {
        const { banner, textEl } = installBanner();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/failing_batch.sql',
                executingSources: new Set(),
                resultSets: [
                    { isLog: false, isError: true, data: [[1]] }
                ]
            }
        });

        const messagesModule: {
            updateExecutionStatusBanner: () => void;
        } = require('../../media/resultPanel/messages.js');
        const { subscribeRunningUiRefresh } = require('../../media/resultPanel/runningUiDelay.js');
        subscribeRunningUiRefresh(() => {
            messagesModule.updateExecutionStatusBanner();
        });

        messagesModule.updateExecutionStatusBanner();

        expect(textEl.textContent).toContain('failing_batch.sql: completed with errors');
        expect(textEl.textContent).toContain('Partial results remain available: 1 rows');
        expect(banner.title).toContain('error result set');
    });
});
