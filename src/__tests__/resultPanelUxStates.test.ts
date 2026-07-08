jest.mock('../../media/resultPanel/utils.js', () => ({
    validateRequiredLibraries: jest.fn(() => null),
    formatCellValue: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn),
    showError: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    resetGrids: jest.fn(),
    addGrid: jest.fn(),
    getAllGrids: jest.fn(() => []),
    setColumnFilterState: jest.fn(),
    getAggregationState: jest.fn(),
    setAggregationState: jest.fn(),
    setGlobalDragState: jest.fn(),
    getGlobalDragState: jest.fn(),
    getSearchMatches: jest.fn(),
    getSearchWorker: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getPinnedColumnsState: jest.fn(),
    setPinnedColumnsState: jest.fn(),
    getGlobalFilterState: jest.fn(() => ''),
    setGlobalFilterState: jest.fn(),
    setResultFormattingState: jest.fn()
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

describe('result panel UX states', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it('renders a clearer empty-state card for an active source with no buffered results', () => {
        const container = { innerHTML: '' };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'gridContainer' ? container : null))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/customer_report.sql',
                resultSets: []
            }
        });

        const gridModule: {
            renderGrids: () => void;
        } = require('../../media/resultPanel/grid.js');

        gridModule.renderGrids();

        expect(container.innerHTML).toContain('No Results Yet');
        expect(container.innerHTML).toContain('does not have buffered tabular results');
        expect(container.innerHTML).toContain('wait for streaming to finish');
    });

    it('renders a success-toned statement-complete card for non-tabular results', () => {
        const appendedChildren: Array<{ innerHTML: string; className: string; style: Record<string, string> }> = [];
        const wrapperFactory = () => {
            const wrapper = {
                className: '',
                style: {} as Record<string, string>,
                innerHTML: '',
                dataset: {},
                appendChild: jest.fn()
            };
            appendedChildren.push(wrapper);
            return wrapper;
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn(() => wrapperFactory()),
                getElementById: jest.fn(() => null)
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/ddl.sql',
                resultSets: [{ rowsAffected: 3, message: 'CREATE TABLE completed' }]
            }
        });

        const gridModule: {
            createResultSetGrid: (
                rs: Record<string, unknown>,
                rsIndex: number,
                container: { appendChild: (child: unknown) => void },
                ...rest: unknown[]
            ) => void;
        } = require('../../media/resultPanel/grid.js');

        const container = { appendChild: jest.fn() };
        gridModule.createResultSetGrid(
            { data: [], rowsAffected: 3, message: 'CREATE TABLE completed' },
            0,
            container,
            null,
            null,
            null,
            null,
            null,
            null
        );

        expect(appendedChildren[0]?.innerHTML).toContain('Statement Completed');
        expect(appendedChildren[0]?.innerHTML).toContain('state-success');
        expect(appendedChildren[0]?.innerHTML).toContain('rerun a SELECT-style query if you expected rows');
    });

    it('hides the loading overlay when the user dismisses it during execution', () => {
        const overlay = {
            classList: {
                add: jest.fn(),
                remove: jest.fn()
            }
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'loadingOverlay' ? overlay : null))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/batch.sql',
                executingSources: new Set(['file:///queries/batch.sql']),
                resultSets: [{ isLog: true, data: ['log line'] }]
            }
        });

        const gridModule: {
            dismissLoadingOverlay: () => void;
            updateLoadingState: () => void;
            isLoadingOverlayDismissed: () => boolean;
        } = require('../../media/resultPanel/grid.js');

        gridModule.updateLoadingState();
        expect(overlay.classList.add).toHaveBeenCalledWith('visible');

        gridModule.dismissLoadingOverlay();
        expect(gridModule.isLoadingOverlayDismissed()).toBe(true);
        expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    });

    it('resets the dismissed loading overlay when execution finishes', () => {
        const overlay = {
            classList: {
                add: jest.fn(),
                remove: jest.fn()
            }
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'loadingOverlay' ? overlay : null))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/batch.sql',
                executingSources: new Set(['file:///queries/batch.sql']),
                resultSets: [{ isLog: true, data: ['log line'] }]
            }
        });

        const gridModule: {
            dismissLoadingOverlay: () => void;
            updateLoadingState: () => void;
            isLoadingOverlayDismissed: () => boolean;
        } = require('../../media/resultPanel/grid.js');

        gridModule.dismissLoadingOverlay();
        expect(gridModule.isLoadingOverlayDismissed()).toBe(true);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/batch.sql',
                executingSources: new Set<string>(),
                resultSets: [{ isLog: true, data: ['log line'] }]
            }
        });

        gridModule.updateLoadingState();

        expect(gridModule.isLoadingOverlayDismissed()).toBe(false);
        expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    });

    it('tracks loading overlay dismissal per active source', () => {
        const overlay = {
            classList: {
                add: jest.fn(),
                remove: jest.fn()
            }
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'loadingOverlay' ? overlay : null))
            }
        });

        const sourceA = 'file:///queries/a.sql';
        const sourceB = 'file:///queries/b.sql';

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceA,
                executingSources: new Set([sourceA, sourceB]),
                resultSets: [{ isLog: true, data: ['log line'] }]
            }
        });

        const gridModule: {
            dismissLoadingOverlay: () => void;
            updateLoadingState: () => void;
            isLoadingOverlayDismissed: () => boolean;
        } = require('../../media/resultPanel/grid.js');

        gridModule.dismissLoadingOverlay();
        expect(gridModule.isLoadingOverlayDismissed()).toBe(true);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceB,
                executingSources: new Set([sourceA, sourceB]),
                resultSets: [{ isLog: true, data: ['other log'] }]
            }
        });

        gridModule.updateLoadingState();
        expect(gridModule.isLoadingOverlayDismissed()).toBe(false);
        expect(overlay.classList.add).toHaveBeenCalledWith('visible');
    });
});
