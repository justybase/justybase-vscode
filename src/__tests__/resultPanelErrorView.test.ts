jest.mock('../../media/resultPanel/utils.js', () => ({
    validateRequiredLibraries: jest.fn(),
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

describe('result panel error view', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    interface MockElement {
        tagName: string;
        className: string;
        textContent: string;
        title: string;
        innerHTML: string;
        style: Record<string, string>;
        dataset: Record<string, string>;
        children: MockElement[];
        appendChild: jest.Mock<MockElement, [MockElement]>;
        append: (...nodes: Array<MockElement | string>) => void;
        setAttribute: (name: string, value: string) => void;
        onclick?: () => void;
    }

    function createMockElement(tagName = 'div'): MockElement {
        const element: MockElement = {
            tagName,
            className: '',
            textContent: '',
            title: '',
            innerHTML: '',
            style: {},
            dataset: {},
            children: [],
            appendChild: jest.fn((child: MockElement) => {
                element.children.push(child);
                return child;
            }),
            append: (...nodes: Array<MockElement | string>) => {
                for (const node of nodes) {
                    if (typeof node === 'string') {
                        element.textContent += node;
                    } else {
                        element.children.push(node);
                    }
                }
            },
            setAttribute: jest.fn(),
            onclick: undefined as undefined | (() => void)
        };

        return element;
    }

    it('renders a recovery hint and an Open Logs action for error results', () => {
        const createdElements: Array<ReturnType<typeof createMockElement>> = [];
        const logTab = { click: jest.fn() };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => {
                    const element = createMockElement(tag);
                    createdElements.push(element);
                    return element;
                }),
                querySelectorAll: jest.fn((selector: string) => (
                    selector === '.result-set-tab' ? [{ click: jest.fn() }, logTab] : []
                ))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                resultSets: [
                    { isError: true, data: [] },
                    { isLog: true, data: [] }
                ]
            }
        });

        Object.defineProperty(global, 'vscode', {
            configurable: true,
            writable: true,
            value: {
                postMessage: jest.fn()
            }
        });

        const gridModule: {
            createErrorView: (
                rs: Record<string, unknown>,
                rsIndex: number,
                container: { appendChild: (child: unknown) => void }
            ) => void;
        } = require('../../media/resultPanel/grid.js');

        const container = { appendChild: jest.fn() };
        gridModule.createErrorView(
            { message: 'Syntax error', sql: 'SELECT * FORM test', isError: true, data: [] },
            0,
            container
        );

        const hint = createdElements.find(element => element.className === 'error-recovery-hint');
        expect(hint?.textContent).toContain('Review Logs for the full execution timeline');

        const openLogsButton = createdElements.find(element => element.textContent === 'Open Logs');
        expect(openLogsButton).toBeDefined();
        openLogsButton?.onclick?.();
        expect(logTab.click).toHaveBeenCalled();
    });

    it('shows SQLSTATE and severity, keeps detail and hint collapsible, and never renders the raw payload', () => {
        const createdElements: Array<ReturnType<typeof createMockElement>> = [];
        const logTab = { click: jest.fn() };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => {
                    const element = createMockElement(tag);
                    createdElements.push(element);
                    return element;
                }),
                querySelectorAll: jest.fn((selector: string) => (
                    selector === '.result-set-tab' ? [{ click: jest.fn() }, logTab] : []
                )),
            },
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: { resultSets: [{ isError: true, data: [] }, { isLog: true, data: [] }] },
        });

        Object.defineProperty(global, 'vscode', {
            configurable: true,
            writable: true,
            value: { postMessage: jest.fn() },
        });

        const gridModule: {
            createErrorView: (
                rs: Record<string, unknown>,
                rsIndex: number,
                container: { appendChild: (child: unknown) => void }
            ) => void;
        } = require('../../media/resultPanel/grid.js');

        gridModule.createErrorView(
            {
                message: 'relation "MISSING" does not exist',
                sql: 'SELECT * FROM MISSING',
                isError: true,
                data: [],
                errorDetails: {
                    code: '42P01',
                    severity: 'ERROR',
                    detail: 'The referenced relation was not found.',
                    hint: 'Check the table name.',
                    raw: 'SERROR-RAW-PAYLOAD',
                },
            },
            0,
            { appendChild: jest.fn() },
        );

        const diagnostics = createdElements.find(element => element.className === 'error-diagnostics');
        expect(diagnostics).toBeDefined();

        const lineTexts = createdElements
            .filter(element => element.className === 'error-diagnostic-line')
            .map(element => element.children.map(child => `${child.textContent}`).join(''));
        expect(lineTexts.some(text => text.includes('42P01'))).toBe(true);
        expect(lineTexts.some(text => text.includes('ERROR'))).toBe(true);
        expect(lineTexts.some(text => text.includes('The referenced relation was not found.'))).toBe(true);
        expect(lineTexts.some(text => text.includes('Check the table name.'))).toBe(true);

        const toggle = createdElements.find(element => element.className === 'error-details-toggle');
        expect(toggle?.innerHTML).toContain('Show backend diagnostics');
        const panel = createdElements.find(element => element.className === 'error-details');
        expect(panel?.className).not.toContain('visible');

        const copyBtn = createdElements.find(element => element.className.includes('error-copy-diagnostics'));
        expect(copyBtn?.textContent).toBe('Copy diagnostics');

        // The driver payload is never part of the rendered diagnostics.
        const rendered = createdElements
            .map(element => `${element.textContent}${element.innerHTML}${element.title}`)
            .join('\n');
        expect(rendered).not.toContain('RAW-PAYLOAD');
    });
});
