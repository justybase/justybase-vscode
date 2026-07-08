jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    setActiveGridIndex: jest.fn(),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getScrollStateFromGlobalCache: jest.fn()
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    saveAllGridStates: jest.fn(),
    getSavedStateFor: jest.fn()
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    updateControlsVisibility: jest.fn(),
    syncGlobalFilterInput: jest.fn()
}));

jest.mock('../../media/resultPanel/export.js', () => ({
    clearLogs: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn()
}));

describe('result panel result-set tabs', () => {
    beforeEach(() => {
        jest.resetModules();
        Object.defineProperty(global, 'vscode', {
            configurable: true,
            writable: true,
            value: {
                postMessage: jest.fn()
            }
        });
    });

    function createMockElement(tagName = 'div') {
        const element = {
            tagName,
            className: '',
            textContent: '',
            title: '',
            style: {} as Record<string, string>,
            children: [] as unknown[],
            appendChild: jest.fn((child: unknown) => {
                element.children.push(child);
                return child;
            }),
            insertBefore: jest.fn((child: unknown) => {
                element.children.unshift(child);
                return child;
            }),
            querySelector: jest.fn(() => null),
            addEventListener: jest.fn(),
            setAttribute: jest.fn(),
            classList: {
                add: (...classes: string[]) => {
                    const next = new Set((element.className || '').split(' ').filter(Boolean));
                    classes.forEach(className => next.add(className));
                    element.className = Array.from(next).join(' ');
                },
                toggle: (className: string, force?: boolean) => {
                    const classes = new Set((element.className || '').split(' ').filter(Boolean));
                    const shouldAdd = force ?? !classes.has(className);
                    if (shouldAdd) {
                        classes.add(className);
                    } else {
                        classes.delete(className);
                    }
                    element.className = Array.from(classes).join(' ');
                },
                contains: (className: string) => (element.className || '').split(' ').includes(className),
            }
        };

        return element;
    }

    it('adds an Error badge to error result tabs', () => {
        const createdElements: Array<ReturnType<typeof createMockElement>> = [];

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => {
                    const element = createMockElement(tag);
                    createdElements.push(element);
                    return element;
                })
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/test.sql',
                pinnedResults: []
            }
        });

        const tabsModule: {
            createResultSetTab: (rs: Record<string, unknown>, index: number) => { children: unknown[] };
        } = require('../../media/resultPanel/tabs.js');

        const tab = tabsModule.createResultSetTab({ isError: true, data: [[1]] }, 0);
        const badge = (tab.children as Array<{ textContent?: string; className?: string }>).find(child => child.textContent === 'Error');

        expect(badge).toBeDefined();
        expect(badge?.className).toContain('state-error');
    });

    it('adds a Partial badge to cancelled result tabs', () => {
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => createMockElement(tag))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/test.sql',
                pinnedResults: []
            }
        });

        const tabsModule: {
            createResultSetTab: (rs: Record<string, unknown>, index: number) => { children: unknown[] };
        } = require('../../media/resultPanel/tabs.js');

        const tab = tabsModule.createResultSetTab({ isCancelled: true, data: [[1], [2]] }, 0);
        const badge = (tab.children as Array<{ textContent?: string; className?: string }>).find(child => child.textContent === 'Partial');

        expect(badge).toBeDefined();
        expect(badge?.className).toContain('state-cancelled');
    });

    it('adds an Empty badge to successful empty result tabs', () => {
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => createMockElement(tag))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/test.sql',
                pinnedResults: []
            }
        });

        const tabsModule: {
            createResultSetTab: (rs: Record<string, unknown>, index: number) => { children: unknown[] };
        } = require('../../media/resultPanel/tabs.js');

        const tab = tabsModule.createResultSetTab({ data: [] }, 0);
        const badge = (tab.children as Array<{ textContent?: string; className?: string }>).find(child => child.textContent === 'Empty');

        expect(badge).toBeDefined();
        expect(badge?.className).toContain('state-empty');
    });

    it('sets a descriptive title for the Logs tab label', () => {
        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                createElement: jest.fn((tag: string) => createMockElement(tag))
            }
        });

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: 'file:///queries/test.sql',
                pinnedResults: []
            }
        });

        const tabsModule: {
            createResultSetTab: (rs: Record<string, unknown>, index: number) => { children: unknown[] };
        } = require('../../media/resultPanel/tabs.js');

        const tab = tabsModule.createResultSetTab({ isLog: true, data: [] }, 0);
        const label = (tab.children as Array<{ textContent?: string; title?: string }>).find(child => child.textContent === 'Logs');

        expect(label?.title).toBe('Execution details and status history');
    });
});
