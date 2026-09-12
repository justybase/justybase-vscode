import { encode } from '@msgpack/msgpack';
import '@testing-library/jest-dom';
import { act } from 'react';
import { fireEvent, render, screen, cleanup, within } from '@testing-library/react';
import {
    SharedResultPanelApp,
    SharedResultPanelController,
    decodeSharedRows,
    displaySharedRows,
    disposeSharedResultPanel,
    mountSharedResultPanelIfConfigured,
    normalizeSharedColumns,
    normalizeSharedResultSet,
    sharedAnalysisQuerySpec,
    sharedResultPanelMode,
} from '../sharedView.js';
import { asHostMessage } from '../protocol.js';

function hydrateMessage(resultSets: unknown[], activeResultSetIndex = 0, executingSources: string[] = []): unknown {
    return {
        command: 'hydrate',
        data: {
            activeSourceJson: JSON.stringify('file:///query.sql'),
            activeResultSetIndex,
            executingSourcesJson: JSON.stringify(executingSources),
            resultSetsMsgPack: encode(resultSets),
            resultSyncVersion: 3,
        },
    };
}

function appendMessage(overrides: Record<string, unknown> = {}): unknown {
    return {
        command: 'appendRows',
        sourceUri: 'file:///query.sql',
        resultSetIndex: 0,
        rows: [[1, 'first']],
        totalRows: 1,
        isLastChunk: false,
        limitReached: false,
        isFirstChunk: true,
        columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
        executionTimestamp: 42,
        resultSetId: 'stream-result',
        chunkSequence: 0,
        fromRow: 0,
        ...overrides,
    };
}

afterEach(() => {
    cleanup();
    disposeSharedResultPanel();
    delete (globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__;
    document.body.innerHTML = '';
    document.head.querySelectorAll('#justybase-shared-result-panel-styles').forEach(node => node.remove());
});

describe('shared VS Code Result Panel adapter', () => {
    it('normalizes host payloads and applies filtering and sorting without leaking buffers to ui-core', () => {
        expect(sharedResultPanelMode('shared')).toBe(true);
        expect(sharedResultPanelMode('legacy')).toBe(false);
        expect(sharedResultPanelMode({ mode: 'shared' })).toBe(false);
        expect(normalizeSharedColumns(undefined)).toEqual([]);
        expect(normalizeSharedColumns([{ name: 'id', type: 'INTEGER' }, { name: 'amount', type: 'NUMERIC', scale: 2 }, { header: 'name' }, null, { name: '' }])).toEqual([
            { name: 'id', type: 'INTEGER' },
            { name: 'amount', type: 'NUMERIC', scale: 2 },
            { name: 'name', type: undefined },
        ]);
        expect(decodeSharedRows([[1], 'not a row', null])).toEqual([[1]]);
        expect(decodeSharedRows(encode([[2, 'two']]))).toEqual([[2, 'two']]);
        expect(decodeSharedRows({ type: 'Buffer', data: Array.from(encode([[3]])) })).toEqual([[3]]);
        expect(decodeSharedRows(new Uint8Array([255, 0, 1]))).toEqual([]);
        expect(decodeSharedRows({ data: ['bad', -1, 300] })).toEqual([]);
        expect(decodeSharedRows({ nope: true })).toEqual([]);

        const normalized = normalizeSharedResultSet({
            resultSetId: 'result-1',
            executionTimestamp: 7,
            columns: [{ name: 'id' }],
            data: [[2], [1]],
            totalRowCount: 1,
            message: 'done',
        });
        expect(normalized).toMatchObject({ resultSetId: 'result-1', totalRowCount: 2, rows: [[2], [1]] });
        expect(normalizeSharedResultSet(null)).toBeUndefined();
        expect(normalizeSharedResultSet({ data: 'bad', columns: 'bad', isError: true })).toMatchObject({
            rows: [],
            columns: [],
            isError: true,
            totalRowCount: 0,
        });

        const columns = [{ name: 'id' }, { name: 'label' }];
        const rows = [[2, 'Beta'], [1, 'Alpha'], [3, 'Beta']];
        expect(displaySharedRows(rows, columns, 'alpha', [])).toEqual([[1, 'Alpha']]);
        expect(displaySharedRows(rows, columns, '', [{ column: 'id', descending: true }])).toEqual([[3, 'Beta'], [2, 'Beta'], [1, 'Alpha']]);
        expect(displaySharedRows(rows, columns, '', [{ column: 'missing', descending: false }])).toEqual(rows);
    });

    it('hydrates stable result identities and keeps execution state in the shared store', () => {
        const controller = new SharedResultPanelController();
        let notifications = 0;
        const unsubscribe = controller.subscribe(() => { notifications += 1; });
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'result-1',
                executionTimestamp: 10,
                columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
                data: [[1, 'one'], [2, 'two']],
                totalRowCount: 2,
            },
            {
                resultSetId: 'result-error',
                columns: [{ name: 'message' }],
                data: [],
                isError: true,
                message: 'fixture failed',
            },
        ], 0));

        const state = controller.getState();
        const first = Object.values(state.results.byResultSetId).find(result => result.resultSetId === 'result-1');
        const failed = Object.values(state.results.byResultSetId).find(result => result.resultSetId === 'result-error');
        expect(first?.status).toBe('complete');
        expect(first?.sourceId).toBe('file:///query.sql');
        expect(first?.storageId).toBeUndefined();
        expect(controller.getRows(first)).toEqual([[1, 'one'], [2, 'two']]);
        expect(failed).toMatchObject({ status: 'error', message: 'fixture failed' });
        expect(state.results.activeResultSetId).toBe('result-1');
        expect(state.capabilities.some(capability => capability.key === 'result-panel.data-grid')).toBe(true);
        expect(notifications).toBeGreaterThan(5);

        controller.updateView('result-1', {
            globalFilter: 'one',
            sorting: [{ column: 'id', descending: true }],
            grouping: ['id'],
            aggregation: 'count',
            pivotColumn: 'label',
            scrollTop: 128,
            scrollLeft: 32,
            anchorRow: 4,
        });
        expect(controller.activeResult()?.view).toMatchObject({ globalFilter: 'one', scrollTop: 128, scrollLeft: 32, anchorRow: 4 });
        controller.selectResult('result-error');
        expect(controller.getState().results.activeResultSetId).toBe('result-error');
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'result-1',
                columns: [{ name: 'id', type: 'INTEGER' }],
                data: [[3, 'replacement']],
                totalRowCount: 1,
            },
        ]));
        expect(Object.values(controller.getState().results.byResultSetId).map(result => result.resultSetId)).toEqual(['result-1']);
        expect(controller.getRows(failed)).toEqual([]);
        controller.selectSource('missing-source');
        controller.refresh();
        controller.copyActive();
        controller.exportActive();
        controller.setSurface('history');
        expect(controller.getState().shell.activeSurface).toBe('history');

        unsubscribe();
        controller.dispose();
        controller.dispose();
        expect(() => controller.handleHostMessage(hydrateMessage([]))).not.toThrow();
    });

    it('rejects foreign, duplicated and delayed stream messages and completes cancellation explicitly', () => {
        const controller = new SharedResultPanelController();
        expect(asHostMessage(appendMessage())).toBeDefined();
        controller.handleHostMessage(appendMessage());
        expect(Object.values(controller.getState().results.byResultSetId).map(item => ({ id: item.resultSetId, source: item.sourceId, status: item.status }))).toHaveLength(1);
        let result = controller.activeResult();
        expect(result).toMatchObject({ resultSetId: 'stream-result', status: 'streaming', loadedRowCount: 1 });
        expect(controller.getRows(result)).toEqual([[1, 'first']]);

        controller.handleHostMessage(appendMessage({ rows: [[99, 'duplicate']], chunkSequence: 0, isFirstChunk: false, fromRow: 1, totalRows: 2 }));
        expect(controller.getRows(controller.activeResult())).toEqual([[1, 'first']]);
        controller.handleHostMessage(appendMessage({ rows: [[88, 'gap']], chunkSequence: 2, isFirstChunk: false, fromRow: 1, totalRows: 2 }));
        expect(controller.getRows(controller.activeResult())).toEqual([[1, 'first']]);
        controller.handleHostMessage(appendMessage({ rows: [[2, 'second']], chunkSequence: 1, isFirstChunk: false, fromRow: 1, totalRows: 2 }));
        expect(controller.getRows(controller.activeResult())).toEqual([[1, 'first'], [2, 'second']]);

        controller.handleHostMessage({ command: 'appendRows', sourceUri: 'other.sql', resultSetIndex: 0, rows: [[3]], totalRows: 3, isLastChunk: false, limitReached: false });
        controller.handleHostMessage({ ...(appendMessage({ chunkSequence: 2, isFirstChunk: false, fromRow: 2, totalRows: 3 }) as Record<string, unknown>), resultSetId: 'foreign-result' });
        controller.handleHostMessage({ command: 'streamingComplete', sourceUri: 'file:///query.sql', resultSetIndex: 0, resultSetId: 'stream-result', totalRows: 2, limitReached: false, lastChunkSequence: 8 });
        expect(controller.activeResult()?.status).toBe('streaming');
        controller.handleHostMessage({ command: 'streamingComplete', sourceUri: 'file:///query.sql', resultSetIndex: 0, resultSetId: 'stream-result', totalRows: 2, limitReached: false, lastChunkSequence: 1 });
        expect(controller.activeResult()).toMatchObject({ status: 'complete', totalRowCount: 2 });

        const cancelled = new SharedResultPanelController();
        cancelled.handleHostMessage(appendMessage());
        cancelled.cancel(undefined);
        expect(cancelled.activeResult()?.cancellation).toBe('requested');
        cancelled.handleHostMessage({ command: 'cancelExecution', sourceUri: 'file:///query.sql' });
        result = cancelled.activeResult();
        expect(result).toMatchObject({ status: 'cancelled', cancellation: 'cancelled' });
        cancelled.handleHostMessage(appendMessage({ isFirstChunk: false, chunkSequence: 1, fromRow: 1, rows: [[9]], totalRows: 2 }));
        expect(cancelled.getRows(cancelled.activeResult())).toEqual([[1, 'first']]);

        controller.dispose();
        cancelled.dispose();
    });

    it('hydrates disk-backed windows and requests the next row window from the host', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage({
            command: 'diskBackedActivate',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            resultSetId: 'disk-result',
            totalRows: 3,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1]],
            limitReached: false,
        });
        let result = controller.activeResult();
        expect(result).toMatchObject({ resultSetId: 'disk-result', status: 'streaming', totalRowCount: 3, loadedRowCount: 1 });
        controller.loadMore(result!);
        controller.handleHostMessage({
            command: 'rowWindow',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            offset: 1,
            rows: [[2], [3]],
            requestId: 1,
            totalRows: 3,
        });
        result = controller.activeResult();
        expect(controller.getRows(result)).toEqual([[1], [2], [3]]);
        expect(result).toMatchObject({ loadedRowCount: 3, totalRowCount: 3 });
        controller.dispose();
    });

    it('runs shared aggregate, group and pivot analysis through host responses', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'analysis-result',
                columns: [
                    { name: 'REGION', type: 'VARCHAR' },
                    { name: 'CHANNEL', type: 'VARCHAR' },
                    { name: 'AMOUNT', type: 'NUMERIC', scale: 2 },
                ],
                data: [['EU', 'WEB', '10.00'], ['EU', 'STORE', '2.50'], ['US', 'WEB', '7.25']],
                totalRowCount: 3,
            },
        ]));
        const result = controller.activeResult();
        expect(result).toBeDefined();
        expect(sharedAnalysisQuerySpec({
            ...result!,
            view: {
                ...result!.view,
                globalFilter: 'web',
                columnFilters: { AMOUNT: '> 1' },
                sorting: [{ column: 'AMOUNT', descending: true }],
            },
        })).toEqual({
            globalSearch: 'web',
            columnFilters: [{ columnIndex: 2, conditions: [{ type: 'contains', value: '> 1' }] }],
        });

        const aggregatePromise = controller.requestAnalysis('aggregate', result!);
        controller.handleHostMessage({
            command: 'databaseAggregationResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: 1,
            aggregations: [
                { columnIndex: 0, fn: 'count', value: 3, filteredRowCount: 3 },
                { columnIndex: 0, fn: 'min', value: 'EU' },
                { columnIndex: 0, fn: 'max', value: 'US' },
                { columnIndex: 2, fn: 'count', value: 3, filteredRowCount: 3 },
                { columnIndex: 2, fn: 'sum', value: '19.75' },
                { columnIndex: 2, fn: 'avg', value: '6.5833' },
                { columnIndex: 2, fn: 'min', value: '2.50' },
                { columnIndex: 2, fn: 'max', value: '10.00' },
            ],
        });
        const aggregate = await aggregatePromise;
        expect(aggregate.kind).toBe('aggregate');
        expect(aggregate.summary).toContain('3');
        expect(aggregate.rows.find(row => row[0] === 'AMOUNT')).toEqual(['AMOUNT', 3, '19.75', '6.5833', '2.50', '10.00']);

        const groupPromise = controller.requestAnalysis('group', result!);
        controller.handleHostMessage({
            command: 'databaseGroupingResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: 2,
            columns: [
                { name: 'REGION', type: 'VARCHAR', kind: 'group' },
                { name: 'COUNT', type: 'BIGINT', kind: 'count' },
                { name: 'SUM_AMOUNT', type: 'NUMERIC', kind: 'aggregate' },
                { name: 'ROW_COUNT_PERCENTAGE', type: 'NUMERIC', kind: 'percentage' },
            ],
            rows: [['EU', 2, '12.50', '66.67'], ['US', 1, '7.25', '33.33']],
            totalRows: 2,
        });
        const group = await groupPromise;
        expect(group.kind).toBe('group');
        expect(group.rows).toEqual([['EU', 2, '12.50', '66.67'], ['US', 1, '7.25', '33.33']]);

        const pivotPromise = controller.requestAnalysis('pivot', result!);
        controller.handleHostMessage({
            command: 'databaseGroupingResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: 3,
            columns: [
                { name: 'REGION', type: 'VARCHAR', kind: 'group' },
                { name: 'CHANNEL', type: 'VARCHAR', kind: 'group' },
                { name: 'SUM_AMOUNT', type: 'NUMERIC', kind: 'aggregate' },
                { name: 'ROW_COUNT_PERCENTAGE', type: 'NUMERIC', kind: 'percentage' },
            ],
            rows: [['EU', 'WEB', '10.00', '33.33'], ['EU', 'STORE', '2.50', '33.33'], ['US', 'WEB', '7.25', '33.33']],
            totalRows: 3,
        });
        const pivot = await pivotPromise;
        expect(pivot.kind).toBe('pivot');
        expect(pivot.columns.map(column => column.name)).toEqual(['REGION', 'WEB', 'STORE']);
        expect(pivot.rows).toEqual([['EU', '10.00', '2.50'], ['US', '7.25', null]]);
        controller.dispose();
    });

    it('rejects stale, mismatched and failed analysis requests', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'analysis-errors-result',
                columns: [{ name: 'CATEGORY', type: 'VARCHAR' }, { name: 'AMOUNT', type: 'NUMERIC' }],
                data: [['EU', 10]],
                totalRowCount: 1,
            },
        ]));
        const result = controller.activeResult()!;

        await expect(controller.requestAnalysis('aggregate', { ...result, resultSetId: 'replaced-result' }))
            .rejects.toThrow('no longer active');

        const aggregateForGrouping = controller.requestAnalysis('aggregate', result);
        const aggregateForGroupingId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        controller.handleHostMessage({
            command: 'databaseGroupingResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
            requestId: aggregateForGroupingId,
            columns: [],
            rows: [],
            totalRows: 0,
        });
        await expect(aggregateForGrouping).rejects.toThrow('another analysis');

        const groupForAggregation = controller.requestAnalysis('group', result);
        const groupForAggregationId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        controller.handleHostMessage({
            command: 'databaseAggregationResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
            requestId: groupForAggregationId,
            aggregations: [],
        });
        await expect(groupForAggregation).rejects.toThrow('another analysis');

        const failed = controller.requestAnalysis('aggregate', result);
        const failedId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        controller.handleHostMessage({
            command: 'databaseAggregationResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
            requestId: failedId,
            error: 'aggregation failed on host',
        });
        await expect(failed).rejects.toThrow('aggregation failed on host');

        const superseded = controller.requestAnalysis('group', result);
        const supersededId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: result.resultSetId,
                columns: result.columns,
                data: controller.getRows(result),
                totalRowCount: result.totalRowCount,
            },
        ]));
        controller.handleHostMessage({
            command: 'databaseGroupingResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
            requestId: supersededId,
            columns: [],
            rows: [],
            totalRows: 0,
        });
        await expect(superseded).rejects.toThrow('superseded');

        const disposed = controller.requestAnalysis('aggregate', controller.activeResult()!);
        controller.dispose();
        await expect(disposed).rejects.toThrow('disposed');
    });

    it('covers analysis validation, exact aggregate values and empty query specs', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'analysis-values-result',
                columns: [
                    { name: 'CATEGORY', type: 'VARCHAR' },
                    { name: 'AMOUNT', type: 'NUMERIC' },
                ],
                data: [['EU', '10.00']],
                totalRowCount: 1,
            },
        ]));
        const result = controller.activeResult()!;
        expect(sharedAnalysisQuerySpec({
            ...result,
            view: { ...result.view, globalFilter: '  ', columnFilters: { UNKNOWN: ' ', MISSING: 'not present' } },
        })).toBeUndefined();

        const aggregatePromise = controller.requestAnalysis('aggregate', result);
        const aggregateRequestId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        controller.handleHostMessage({
            command: 'databaseAggregationResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
            requestId: aggregateRequestId,
            aggregations: [
                { columnIndex: 0, fn: 'count', value: 'not-a-count', filteredRowCount: 4 },
                { columnIndex: 0, fn: 'sum', value: { unsupported: true } },
                { columnIndex: 0, fn: 'avg', value: null },
                { columnIndex: 0, fn: 'min', value: 'A' },
                { columnIndex: 0, fn: 'max', value: 'Z' },
                { columnIndex: 1, fn: 'count', value: 1 },
            ],
        });
        const aggregate = await aggregatePromise;
        expect(aggregate.rows.find(row => row[0] === 'CATEGORY')).toEqual([
            'CATEGORY', 0, '[object Object]', null, 'A', 'Z',
        ]);

        const noColumns = { ...result, resultSetId: result.resultSetId, columns: [] };
        await expect(controller.requestAnalysis('group', noColumns)).rejects.toThrow('has no columns');
        const noNumericValue = {
            ...result,
            columns: [{ name: 'CATEGORY', type: 'VARCHAR' }, { name: 'PIVOT', type: 'VARCHAR' }],
        };
        await expect(controller.requestAnalysis('pivot', noNumericValue)).rejects.toThrow('numeric value column');
        controller.dispose();
    });

    it('ignores row windows without a live request or matching result generation', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage({
            command: 'diskBackedActivate',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            resultSetId: 'disk-result',
            totalRows: 3,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1]],
            limitReached: false,
        });
        const result = controller.activeResult();
        controller.loadMore(result!);

        // Replacing the result while the request is in flight must invalidate
        // the old response, even when the host reuses the stable result id.
        controller.handleHostMessage({
            command: 'diskBackedActivate',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            resultSetId: 'disk-result',
            totalRows: 3,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[9]],
            limitReached: false,
        });
        controller.handleHostMessage({
            command: 'rowWindow',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            offset: 1,
            rows: [[2], [3]],
            requestId: 1,
            totalRows: 3,
        });
        controller.handleHostMessage({
            command: 'rowWindow',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            offset: 0,
            rows: [[8]],
            requestId: 999,
            totalRows: 3,
        });

        expect(controller.getRows(controller.activeResult())).toEqual([[9]]);
        controller.dispose();
    });

    it('renders common React presentation states, controls and capability messaging', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'result-1',
                columns: [{ name: 'id' }, { name: 'label' }],
                data: [[1, 'one'], [2, 'two']],
                totalRowCount: 2,
            },
        ]));
        render(<SharedResultPanelApp controller={controller} />);
        expect(screen.getByRole('heading', { name: 'query.sql' })).toBeInTheDocument();
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(screen.getByText('one')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter results' }), { target: { value: 'two' } });
        expect(screen.queryByText('one')).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter results' }), { target: { value: '' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter label' }), { target: { value: 'one' } });
        expect(screen.getByText('one')).toBeInTheDocument();
        expect(screen.queryByText('two')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Group by label' }));
        expect(screen.getByText(/1 rows/)).toBeInTheDocument();
        expect(controller.activeResult()?.view).toMatchObject({ columnFilters: { label: 'one' }, grouping: ['label'] });
        const selectedCell = screen.getByRole('cell', { name: 'one' });
        fireEvent.mouseDown(selectedCell, { button: 0 });
        expect(selectedCell).toHaveClass('ui-data-grid-cell-selected');
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter label' }), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
        fireEvent.click(screen.getByRole('row', { name: '2 two' }));
        expect(screen.getByRole('heading', { name: 'Row details' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('heading', { name: 'Row details' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Schema' }));
        expect(screen.getByText('Schema navigation is not available in this Result Panel yet.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'History' }));
        expect(screen.getByText('History remains available through the host until the shared HistoryPort adapter is enabled.')).toBeInTheDocument();
        controller.dispose();
    });

    it('renders host-backed analysis with the same shared DataGrid', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'analysis-render-result',
                columns: [
                    { name: 'REGION', type: 'VARCHAR' },
                    { name: 'CHANNEL', type: 'VARCHAR' },
                    { name: 'AMOUNT', type: 'NUMERIC' },
                ],
                data: [['EU', 'WEB', 10], ['US', 'WEB', 7]],
                totalRowCount: 2,
            },
        ]));
        render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Aggregate' }));
        act(() => controller.handleHostMessage({
            command: 'databaseAggregationResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: 1,
            aggregations: [
                { columnIndex: 2, fn: 'count', value: 2, filteredRowCount: 2 },
                { columnIndex: 2, fn: 'sum', value: '17' },
                { columnIndex: 2, fn: 'avg', value: '8.5' },
                { columnIndex: 2, fn: 'min', value: '7' },
                { columnIndex: 2, fn: 'max', value: '10' },
            ],
        }));
        expect(await screen.findByRole('heading', { name: 'Aggregates' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Result analysis' })).toHaveTextContent('17');
        const openValueViewer = jest.fn();
        (window as unknown as { openValueViewer: typeof openValueViewer }).openValueViewer = openValueViewer;
        const analysisRegion = screen.getByRole('region', { name: 'Result analysis' });
        fireEvent.contextMenu(within(analysisRegion).getByRole('cell', { name: '17' }), { clientX: 24, clientY: 36 });
        fireEvent.click(within(analysisRegion).getByRole('menuitem', { name: 'View Cell Value' }));
        expect(openValueViewer).toHaveBeenCalledWith(expect.objectContaining({ value: '17', columnName: 'Sum' }));
        fireEvent.contextMenu(within(analysisRegion).getByRole('cell', { name: '17' }), { clientX: 24, clientY: 36 });
        fireEvent.click(within(analysisRegion).getByRole('menuitem', { name: 'Copy row as JSON' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close result analysis' }));
        expect(screen.queryByRole('heading', { name: 'Aggregates' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Group' }));
        const groupRequestId = (controller as unknown as { analysisRequestId: number }).analysisRequestId;
        act(() => controller.handleHostMessage({
            command: 'databaseGroupingResult',
            sourceUri: 'file:///query.sql',
            resultSetIndex: 0,
            requestId: groupRequestId,
            error: 'grouping failed',
        }));
        expect(await screen.findByRole('alert')).toHaveTextContent('grouping failed');
        fireEvent.click(screen.getByRole('button', { name: 'Close result analysis' }));
        controller.dispose();
    });

    it('mounts only for explicit shared mode, consumes host messages, and cleans up idempotently', async () => {
        document.body.innerHTML = '<div id="shared-ui-root" style="display:none"></div><div class="layout-wrapper"></div>';
        expect(mountSharedResultPanelIfConfigured()).toBe(false);
        (globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__ = 'shared';
        act(() => {
            expect(mountSharedResultPanelIfConfigured()).toBe(true);
        });
        expect(document.body).toHaveClass('shared-ui-mode');
        expect(document.getElementById('shared-ui-root')).toHaveStyle({ display: 'block' });
        expect(document.getElementById('justybase-shared-result-panel-styles')).not.toBeNull();
        expect(mountSharedResultPanelIfConfigured()).toBe(true);
        act(() => window.dispatchEvent(new MessageEvent('message', { data: hydrateMessage([
            { resultSetId: 'listener-result', columns: [{ name: 'id' }], data: [[7]], totalRowCount: 1 },
        ]) })));
        expect(await screen.findByRole('table')).toBeInTheDocument();
        expect(screen.getByText('7')).toBeInTheDocument();
        act(() => disposeSharedResultPanel());
        expect(document.body).not.toHaveClass('shared-ui-mode');
        act(() => disposeSharedResultPanel());
    });
});
