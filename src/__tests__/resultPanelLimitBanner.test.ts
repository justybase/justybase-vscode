interface FakeElement {
    className: string;
    textContent: string;
    title: string;
    type?: string;
    style: Record<string, string>;
    innerHTML: string;
    children: FakeElement[];
    listeners: Record<string, () => void>;
    classList: { add: (name: string) => void; remove: (name: string) => void };
    setAttribute: (name: string, value: string) => void;
    appendChild: (child: FakeElement) => void;
    addEventListener: (type: string, handler: () => void) => void;
}

const mockWindowState: { queryRowLimit: number } = { queryRowLimit: 25000 };
const mockGetResultSetAt = jest.fn();

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    isResultSetRowLimitReached: jest.fn(() => false),
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    getAnalysisLimitWarning: jest.fn(() => ''),
}));

jest.mock('../../media/resultPanel/diskGrouping.js', () => ({
    getDiskGroupingTruncationMessage: jest.fn(() => ''),
}));

jest.mock('../../media/resultPanel/types.js', () => ({
    getResultPanelWindow: () => mockWindowState,
    getResultSetAt: (...args: unknown[]) => mockGetResultSetAt(...args),
}));

function createFakeElement(tag = 'div'): FakeElement {
    const classes = new Set<string>();
    const element: FakeElement = {
        className: '',
        textContent: '',
        title: '',
        type: undefined,
        style: {},
        innerHTML: '',
        children: [],
        listeners: {},
        classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
        },
        setAttribute: () => undefined,
        appendChild: (child: FakeElement) => {
            element.children.push(child);
        },
        addEventListener: (type: string, handler: () => void) => {
            element.listeners[type] = handler;
        },
    };
    Object.defineProperty(element, 'tagName', { value: tag.toUpperCase() });
    return element;
}

describe('result panel row limit banner', () => {
    let banner: FakeElement;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockWindowState.queryRowLimit = 25000;
        banner = createFakeElement();
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => (id === 'resultLimitBanner' ? banner : null)),
                createElement: jest.fn((tag: string) => createFakeElement(tag)),
            },
        });
    });

    function loadBannerModule(): { updateResultLimitBanner: () => void } {
        return require('../../media/resultPanel/banners.js') as { updateResultLimitBanner: () => void };
    }

    function loadFilterMock(): { isResultSetRowLimitReached: jest.Mock } {
        return require('../../media/resultPanel/filter.js') as { isResultSetRowLimitReached: jest.Mock };
    }

    it('renders the warning with a dismiss button', () => {
        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-1',
            data: new Array(25000).fill([1]),
            limitReached: true,
        });
        loadFilterMock().isResultSetRowLimitReached.mockReturnValue(true);

        loadBannerModule().updateResultLimitBanner();

        expect(banner.style.display).toBe('flex');
        expect(banner.children.map(child => child.className)).toEqual([
            'result-limit-banner__icon',
            'result-limit-banner__text',
            'result-limit-banner__dismiss',
        ]);
        expect(banner.children[1].textContent).toContain('Query row limit reached: 25,000 of 25,000 rows fetched');
        expect(typeof banner.children[2].listeners.click).toBe('function');
    });

    it('hides the warning after the user dismisses it', () => {
        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-1',
            data: new Array(25000).fill([1]),
            limitReached: true,
        });
        loadFilterMock().isResultSetRowLimitReached.mockReturnValue(true);
        const module = loadBannerModule();

        module.updateResultLimitBanner();
        const dismiss = banner.children[2];
        dismiss.listeners.click();

        expect(banner.style.display).toBe('none');
        expect(banner.innerHTML).toBe('');

        // Later renders (streaming chunks, tab switches) must not bring it back.
        module.updateResultLimitBanner();
        expect(banner.style.display).toBe('none');
    });

    it('does not rebuild identical banner markup on every render', () => {
        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-1',
            data: new Array(25000).fill([1]),
            limitReached: true,
        });
        loadFilterMock().isResultSetRowLimitReached.mockReturnValue(true);
        const module = loadBannerModule();

        module.updateResultLimitBanner();
        const renders = banner.children.length;
        module.updateResultLimitBanner();
        module.updateResultLimitBanner();

        expect(banner.children.length).toBe(renders);
        // innerHTML is only cleared when the visible message changes.
        expect(banner.style.display).toBe('flex');
    });

    it('keeps the warning when a later render only exposes a data window', () => {
        const resultSet = {
            resultSetId: 'rs-1',
            data: new Array(25000).fill([1]),
            limitReached: false,
            totalRowCount: 25000,
        };
        mockGetResultSetAt.mockReturnValue(resultSet);
        const filterMock = loadFilterMock();
        filterMock.isResultSetRowLimitReached.mockReturnValue(true);
        const module = loadBannerModule();

        module.updateResultLimitBanner();
        expect(banner.style.display).toBe('flex');

        // Disk-backed result: only the first page is in `data`, the fetched flag
        // is gone after re-hydration, and the heuristic no longer matches.
        resultSet.data = new Array(100).fill([1]);
        resultSet.totalRowCount = 25000;
        filterMock.isResultSetRowLimitReached.mockReturnValue(false);
        module.updateResultLimitBanner();

        expect(banner.style.display).toBe('flex');
    });

    it('hides the banner when the active result is below the limit', () => {
        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-2',
            data: new Array(10).fill([1]),
            limitReached: false,
        });
        loadFilterMock().isResultSetRowLimitReached.mockReturnValue(false);

        loadBannerModule().updateResultLimitBanner();

        expect(banner.style.display).toBe('none');
    });

    it('shows the warning again for a new execution', () => {
        loadFilterMock().isResultSetRowLimitReached.mockReturnValue(true);
        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-1',
            data: new Array(25000).fill([1]),
            limitReached: true,
        });
        const module = loadBannerModule();

        module.updateResultLimitBanner();
        banner.children[2].listeners.click();
        expect(banner.style.display).toBe('none');

        mockGetResultSetAt.mockReturnValue({
            resultSetId: 'rs-2',
            data: new Array(25000).fill([1]),
            limitReached: true,
        });
        module.updateResultLimitBanner();

        expect(banner.style.display).toBe('flex');
    });
});
