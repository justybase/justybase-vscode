import { getActiveResultViewMode, setActiveResultViewMode, syncAnalysisView } from '../resultPanel/analysis.js';
import { renderExploreView, disposeExploreView } from '../resultPanel/explore/explorePanel.js';
import type { ResultSet } from '../resultPanel/types.js';
jest.mock('../resultPanel/explore/explorePanel.js', () => ({ renderExploreView: jest.fn(), disposeExploreView: jest.fn() }));
jest.mock('../resultPanel/explore/composerTab.js', () => ({ disposeComposerChart: jest.fn() }));
jest.mock('../resultPanel/rowView.js', () => ({ closeRowView: jest.fn() }));
jest.mock('../resultPanel/utils.js', () => ({ formatCellValue: (value: unknown) => String(value) }));
let active = 0;
let results: ResultSet[];
let saved: unknown = {};
jest.mock('../resultPanel/state.js', () => ({ getActiveGridIndex: () => active }));
jest.mock('../resultPanel/protocol.js', () => ({ getHostState: () => saved, setHostState: (state: unknown) => { saved = state; } }));
jest.mock('../resultPanel/types.js', () => ({ getActiveSourceUri: () => 'file:///analysis.sql', getResultSetAt: (index: number) => results[index], getResultSets: () => results, callPanelMethod: jest.fn() }));

describe('Explore analysis mode identity', () => {
    beforeEach(() => { jest.clearAllMocks(); active = 0; saved = {}; results = [{ resultSetId: 'analysis-owner', columns: [], data: [] }];
        document.body.innerHTML = '<select id="viewModeSelect"><option value="table">Table</option><option value="explore">Explore</option></select><div id="gridContainer"></div><div id="analysisContainer"></div>'; });
    it('keeps Explore mode attached to the stable result after index shifts and disposes on exit', () => {
        setActiveResultViewMode('explore'); expect(renderExploreView).toHaveBeenCalledWith(0);
        results.unshift({ resultSetId: 'other-owner', columns: [], data: [] }); active = 1;
        expect(getActiveResultViewMode()).toBe('explore'); syncAnalysisView(); expect(renderExploreView).toHaveBeenLastCalledWith(1);
        setActiveResultViewMode('table'); expect(disposeExploreView).toHaveBeenCalled();
    });
    it('uses legacy timestamp/index fallbacks and forces Logs back to the table', () => {
        results = [{ columns: [], data: [], executionTimestamp: 123 }]; setActiveResultViewMode('explore'); expect(getActiveResultViewMode()).toBe('explore');
        results = [{ columns: [], data: [] }]; expect(getActiveResultViewMode()).toBe('table');
        results[0].isLog = true; syncAnalysisView(); expect(document.getElementById('analysisContainer')?.style.display).toBe('none');
    });
});
