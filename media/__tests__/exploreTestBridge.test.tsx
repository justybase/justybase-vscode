import { handleResultPanelTestBridgeMessage } from '../resultPanel/testBridge.js';
import { postHostMessage } from '../resultPanel/protocol.js';
import { setActiveResultViewMode } from '../resultPanel/analysis.js';
let includeLogs = true;
let missing: 'none' | 'editor' | 'value' | 'button' = 'none';
jest.mock('../resultPanel/protocol.js', () => ({ postHostMessage: jest.fn() }));
jest.mock('../resultPanel/analysis.js', () => ({ setActiveResultViewMode: jest.fn() }));
jest.mock('../resultPanel/databaseFilters.js', () => ({}));
jest.mock('../resultPanel/databaseAggregations.js', () => ({}));
jest.mock('../resultPanel/databaseGrouping.js', () => ({}));
jest.mock('../resultPanel/diskBackedGrid.js', () => ({}));
jest.mock('../resultPanel/filter.js', () => ({}));
jest.mock('../resultPanel/state.js', () => ({ getActiveGridIndex: () => 1 }));
jest.mock('../resultPanel/types.js', () => ({ getResultSets: () => includeLogs ? [{ isLog: true }, { isLog: false }] : [{ isLog: false }] }));
jest.mock('../resultPanel/grid/persistence.js', () => ({}));
jest.mock('../resultPanel/tabs.js', () => ({ switchToResultSet: jest.fn() }));
jest.mock('../resultPanel/trace.js', () => ({ isResultPanelTraceEnabled: () => true, traceResultPanel: jest.fn() }));

/** This test checks the harness itself; real rendering/protocol is tested separately. */
function drawHarnessUi(): void {
    document.body.innerHTML = '<div id="analysisContainer"><div id="exploreSubtitle">All loaded rows</div><div id="exploreFilterBar">Alpha</div><div id="exploreTabContent"></div><div id="exploreSelection"></div></div>';
    const root = document.getElementById('analysisContainer')!;
    const add = (text: string, action: () => void) => { const control = document.createElement('button'); control.textContent = text; control.onclick = action; root.append(control); };
    if (missing !== 'button') add('Add filter', () => {
        if (missing === 'editor') return;
        const editor = document.createElement('section'); editor.className = 'explore-filter-editor';
        editor.innerHTML = `<select><option value="1">Category</option></select>${missing === 'value' ? '' : '<input type="checkbox" aria-label="Alpha">'}<button>Apply</button>`;
        root.append(editor);
    });
    add('Charts', () => { const select = document.createElement('select'); select.setAttribute('aria-label', 'Category'); select.innerHTML = '<option value="1">Category</option>'; root.append(select); });
    add('Run', () => {
        const status = document.createElement('p'); status.className = 'explore-database-status'; status.textContent = 'Database'; root.append(status);
        document.getElementById('exploreTabContent')!.innerHTML = '<table><tbody><tr><td>Fixture</td></tr></tbody></table>';
    });
    add('Explore selection', () => undefined); add('Show rows', () => undefined);
    add('Load rows', () => { document.getElementById('exploreSelection')!.innerHTML = '<table><tbody><tr><td>Fixture</td></tr></tbody></table>'; });
    add('✕ Clear', () => undefined);
}

describe('gated Explore Extension Host bridge workflow', () => {
    beforeEach(() => {
        jest.clearAllMocks(); includeLogs = true; missing = 'none';
        jest.mocked(setActiveResultViewMode).mockImplementation(mode => { if (mode === 'explore') drawHarnessUi(); });
    });
    it.each([true, false])('drives controls and reports only counters with Logs=%s', async logs => {
        includeLogs = logs;
        await handleResultPanelTestBridgeMessage({ requestId: 'explore-test', action: 'exploreWorkflow' });
        expect(postHostMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: { rankedCount: 1, rowCount: 1, filtersRestored: true } }));
        expect(setActiveResultViewMode).toHaveBeenLastCalledWith('table');
    });
    it.each(['editor', 'value', 'button'] as const)('reports missing %s controls as a sanitized failure', async kind => {
        missing = kind;
        await handleResultPanelTestBridgeMessage({ requestId: 'explore-test', action: 'exploreWorkflow', args: { columnIndex: 1, value: 'Alpha' } });
        expect(postHostMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.any(String) }));
    });
});
