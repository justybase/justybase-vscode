import { renderResultSetTabs } from '../tabs';
import { setResultSets, getResultPanelWindow } from '../types';

const posted = jest.fn();
jest.mock('../protocol', () => ({ postHostMessage: (message: unknown) => posted(message) }));
jest.mock('../state', () => ({ getActiveGridIndex: () => 0, getAllGrids: () => [], getGrid: () => undefined, resetEditSession: jest.fn(), setActiveGridIndex: jest.fn() }));
jest.mock('../grid/persistence', () => ({ applyScrollForResultSet: jest.fn(), saveAllGridStates: jest.fn(), getGridWrapperForResultSet: () => null }));
jest.mock('../grid', () => ({ updateControlsVisibility: jest.fn(), syncGlobalFilterInput: jest.fn() }));
jest.mock('../grid/alternateViews', () => ({ extractKeyNetezzaErrorInfo: (value: string) => value }));
jest.mock('../filter', () => ({ renderRowCountInfo: jest.fn() }));
jest.mock('../analysis', () => ({ syncAnalysisView: jest.fn() }));

describe('result tab accessibility', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="resultSetTabs"></div>';
        getResultPanelWindow().activeSource = 'file:///query.sql';
        getResultPanelWindow().pinnedResults = [];
        setResultSets([{ columns: [], data: [], isLog: true, resultSetId: 'logs' }, { columns: [{ name: 'n' }], data: [[1]], resultSetId: 'data' }]);
        posted.mockClear();
        renderResultSetTabs();
    });

    test('uses a tablist, roving tabs, and native labeled pin/close buttons', () => {
        expect(document.querySelector('[role=tablist]')).not.toBeNull();
        const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
        expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1]);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        const close = document.querySelector<HTMLButtonElement>('button.result-set-close-btn')!;
        expect(close.getAttribute('aria-label')).toBe('Close Logs');
        close.click();
        expect(posted).toHaveBeenCalledWith({ command: 'closeResult', sourceUri: 'file:///query.sql', resultSetIndex: 0, resultSetId: 'logs' });
        const pin = document.querySelector<HTMLButtonElement>('button.pin-icon')!;
        expect(pin.getAttribute('aria-pressed')).toBe('false');
        pin.click();
        expect(posted).toHaveBeenCalledWith({ command: 'toggleResultPin', sourceUri: 'file:///query.sql', resultSetIndex: 0, resultSetId: 'logs' });
    });

    test('moves focus with arrows and Home/End and restores focus after rendering', () => {
        const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
        tabs[0].focus();
        tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(document.activeElement).toBe(tabs[1]);
        renderResultSetTabs();
        expect(document.activeElement?.closest<HTMLElement>('[data-result-id]')?.dataset.resultId).toBe('data');
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement?.closest<HTMLElement>('[data-result-id]')?.dataset.resultId).toBe('logs');
    });
});
