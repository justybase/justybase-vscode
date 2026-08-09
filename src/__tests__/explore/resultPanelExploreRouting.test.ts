/**
 * Routing tests for the Explore host messages (full stats, pivot, composer,
 * SQL previews) handled by ResultPanelMessageHandler.
 */

describe('ResultPanelMessageHandler explore routing', () => {
    let handler: import('../../views/resultPanelMessageHandler').ResultPanelMessageHandler;
    let stateManager: import('../../state/resultStateManager').ResultStateManager;
    let exportManager: import('../../export/exportManager').ExportManager;
    let callbacks: import('../../views/resultPanelMessageHandler').MessageHandlerCallbacks;
    let postedMessages: Array<Record<string, unknown>>;

    const { ResultPanelMessageHandler } = require('../../views/resultPanelMessageHandler');
    const { ResultStateManager } = require('../../state/resultStateManager');
    const { ExportManager } = require('../../export/exportManager');

    beforeEach(() => {
        jest.clearAllMocks();
        stateManager = new ResultStateManager();
        exportManager = new ExportManager(stateManager.resultsMap);
        postedMessages = [];
        callbacks = {
            onUpdateWebview: jest.fn(),
            onPostMessage: jest.fn((message: Record<string, unknown>) => {
                postedMessages.push(message);
            }),
            onForceHydrate: jest.fn(),
        };
        handler = new ResultPanelMessageHandler(stateManager, exportManager, callbacks, undefined);
    });

    afterEach(() => {
        stateManager.dispose();
    });

    it('routes requestExploreFullStats through the callback', async () => {
        const callback = jest.fn().mockResolvedValue({
            values: { count: 10, sum: 100 },
            percentilesUnavailable: false,
            sql: 'SELECT 1',
        });
        callbacks.onRequestExploreFullStats = callback;
        handler.handleMessage({
            command: 'requestExploreFullStats',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 7,
            columnIndex: 2,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(callback).toHaveBeenCalledWith('file:///a.sql', 0, 2, undefined, undefined);
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'exploreFullStatsResult',
            requestId: 7,
            columnIndex: 2,
            values: { count: 10, sum: 100 },
        }));
    });

    it('reports full-stats errors back to the webview', async () => {
        callbacks.onRequestExploreFullStats = jest.fn().mockRejectedValue(new Error('no SQL'));
        handler.handleMessage({
            command: 'requestExploreFullStats',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 3,
            columnIndex: 0,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'exploreFullStatsResult',
            requestId: 3,
            error: 'no SQL',
        }));
    });

    it('routes requestExplorePivot through the callback with sanitized rows', async () => {
        const callback = jest.fn().mockResolvedValue({
            columns: [
                { name: 'REGION', kind: 'row' },
                { name: 'V: A', kind: 'value' },
            ],
            rows: [['EU', 42]],
            totalRows: 1,
            pivotValues: ['A'],
            sql: 'SELECT …',
        });
        callbacks.onRequestExplorePivot = callback;
        handler.handleMessage({
            command: 'requestExplorePivot',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 11,
            pivot: { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'sum' },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(callback).toHaveBeenCalled();
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'explorePivotResult',
            requestId: 11,
            columns: expect.any(Array),
            rows: [['EU', 42]],
            totalRows: 1,
            pivotValues: ['A'],
        }));
    });

    it('routes previewExplorePivot to the preview callback', async () => {
        callbacks.onPreviewExplorePivot = jest.fn().mockResolvedValue('SELECT 1');
        handler.handleMessage({
            command: 'previewExplorePivot',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 12,
            pivot: { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'sum' },
            pivotValues: ['A'],
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'explorePivotPreviewResult',
            requestId: 12,
            sql: 'SELECT 1',
        }));
    });

    it('routes requestExploreComposer through the callback', async () => {
        const callback = jest.fn().mockResolvedValue({
            columnIndexes: { bucket: 0, dimension: undefined, split: undefined, measure: 1, previous: 2 },
            rows: [['2024-01-01', 10, 8]],
            sql: 'SELECT …',
        });
        callbacks.onRequestExploreComposer = callback;
        handler.handleMessage({
            command: 'requestExploreComposer',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 21,
            composer: { dateColumnIndex: 0, grain: 'month', measureColumnIndex: 1, aggFn: 'sum', comparePrevious: true },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(callback).toHaveBeenCalled();
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'exploreComposerResult',
            requestId: 21,
            columnIndexes: expect.objectContaining({ bucket: 0, measure: 1 }),
        }));
    });

    it('routes previewExploreFilteredSql to the preview callback', async () => {
        callbacks.onPreviewExploreFilteredSql = jest.fn().mockResolvedValue('SELECT *\nFROM (x) t');
        handler.handleMessage({
            command: 'previewExploreFilteredSql',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 31,
            filters: { dimensions: [{ columnIndex: 0, values: ['EU'] }], dates: [], measures: [] },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'exploreFilteredSqlPreviewResult',
            requestId: 31,
            sql: 'SELECT *\nFROM (x) t',
        }));
    });

    it('falls back with an error when explore callbacks are missing', async () => {
        handler.handleMessage({
            command: 'requestExplorePivot',
            sourceUri: 'file:///a.sql',
            resultSetIndex: 0,
            requestId: 99,
            pivot: { rowColumnIndexes: [0], columnColumnIndex: 1, valueColumnIndex: 2, aggFn: 'sum' },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(postedMessages).toContainEqual(expect.objectContaining({
            command: 'explorePivotResult',
            requestId: 99,
            error: 'Pivot is not available in this context.',
        }));
    });
});
