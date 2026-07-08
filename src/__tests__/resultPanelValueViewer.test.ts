jest.mock('../../media/resultPanel/styles.js', () => ({
    injectStyles: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    setActiveGridIndex: jest.fn(),
    initializeWindowState: jest.fn(),
    setSearchWorker: jest.fn(),
    setSearchMatches: jest.fn(),
    setIsSearching: jest.fn(),
    getActiveGridIndex: jest.fn(() => 0),
    getSearchWorker: jest.fn(),
    getGrid: jest.fn(),
    setRowViewOpen: jest.fn(),
    getRowViewOpen: jest.fn(() => false),
    getGlobalFilterState: jest.fn(() => ''),
    setGlobalFilterState: jest.fn()
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/messages.js', () => ({
    setupStreamingMessageHandler: jest.fn(),
    handleCancelExecution: jest.fn()
}));

jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: jest.fn(),
    switchToResultSet: jest.fn()
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
    updateLoadingState: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    getActiveResultViewMode: jest.fn(() => 'table'),
    initializeAnalysisModeControls: jest.fn(),
    setActiveResultViewMode: jest.fn(),
    syncAnalysisView: jest.fn(),
}));

jest.mock('../../media/resultPanel/formatting.js', () => ({
    openResultFormattingPanel: jest.fn(),
    closeResultFormattingPanel: jest.fn(),
}));

jest.mock('../../media/resultPanel/rangeChart.js', () => ({
    openRangeChartModal: jest.fn(),
    closeRangeChartModal: jest.fn(),
    canCreateRangeChart: jest.fn(),
    openRangeChartFromToolbar: jest.fn(),
    openRangeChartForActiveResult: jest.fn(),
}));

jest.mock('../../media/resultPanel/export.js', () => ({
    clearLogs: jest.fn(),
    openInExcel: jest.fn(),
    openInExcelXlsx: jest.fn(),
    copyAsExcel: jest.fn(),
    exportToCsv: jest.fn(),
    exportToJson: jest.fn(),
    exportToXml: jest.fn(),
    exportToSqlInsert: jest.fn(),
    exportToMarkdown: jest.fn(),
    onDropGroup: jest.fn(),
    onDragOverGroup: jest.fn(),
    onDragLeaveGroup: jest.fn(),
    handleClickExport: jest.fn(),
    toggleExportPrimaryMenu: jest.fn(),
    handleClickQueryLocallyDuckDB: jest.fn(),
    setGlobalDragStateForExport: jest.fn(),
    exportAllVisibleToCsv: jest.fn(),
    exportAllVisibleToJson: jest.fn(),
    exportAllVisibleToXml: jest.fn(),
    exportAllVisibleToSqlInsert: jest.fn(),
    exportAllVisibleToMarkdown: jest.fn(),
    exportAllVisibleToExcel: jest.fn(),
    exportSelectionToCsv: jest.fn(),
    exportSelectionToJson: jest.fn(),
    exportSelectionToExcel: jest.fn(),
    exportAllResultSetsToExcel: jest.fn()
}));

describe('result panel value viewer helpers', () => {
    beforeEach(() => {
        jest.resetModules();
        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                addEventListener: jest.fn()
            }
        });

        const elements = new Map<string, unknown>();
        const overlay = {
            classList: {
                add: jest.fn(),
                remove: jest.fn()
            },
            addEventListener: jest.fn()
        };
        const title = { textContent: '' };
        const meta = { textContent: '' };
        const body = {
            innerHTML: '',
            appendChild: jest.fn()
        };
        const copyBtn = { addEventListener: jest.fn() };
        const closeBtn = { addEventListener: jest.fn() };
        const dismissBtn = { addEventListener: jest.fn() };

        elements.set('valueViewerOverlay', overlay);
        elements.set('valueViewerTitle', title);
        elements.set('valueViewerMeta', meta);
        elements.set('valueViewerBody', body);
        elements.set('valueViewerCopyBtn', copyBtn);
        elements.set('valueViewerCloseBtn', closeBtn);
        elements.set('valueViewerDismissBtn', dismissBtn);

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => elements.get(id) ?? null),
                addEventListener: jest.fn(),
                createElement: jest.fn(() => ({
                    className: '',
                    textContent: ''
                }))
            }
        });
    });

    it('opens and closes the value viewer modal', () => {
        const initModule: {
            openValueViewer: (payload: Record<string, unknown>) => void;
            closeValueViewer: () => void;
        } = require('../../media/resultPanel/init.js');

        initModule.openValueViewer({
            columnName: 'payload',
            dataType: 'varchar',
            rowNumber: 4,
            value: 'long text value',
            isNull: false
        });

        const getElementById = (global as typeof globalThis & {
            document: { getElementById: jest.Mock }
        }).document.getElementById;
        const overlay = getElementById('valueViewerOverlay') as unknown as {
            classList: { add: jest.Mock; remove: jest.Mock };
        };
        const title = getElementById('valueViewerTitle') as unknown as { textContent: string };
        const meta = getElementById('valueViewerMeta') as unknown as { textContent: string };
        const body = getElementById('valueViewerBody') as unknown as { appendChild: jest.Mock };

        expect(title.textContent).toBe('Cell Value: payload');
        expect(meta.textContent).toContain('Type: varchar');
        expect(meta.textContent).toContain('Row: 4');
        expect(body.appendChild).toHaveBeenCalled();
        expect(overlay.classList.add).toHaveBeenCalledWith('visible');

        initModule.closeValueViewer();
        expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    });
});
