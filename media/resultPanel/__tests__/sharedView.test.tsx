import { encode } from '@msgpack/msgpack';
import '@testing-library/jest-dom';
import { act } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import {
    SharedResultPanelApp,
    SharedResultPanelController,
    decodeSharedRows,
    displaySharedRows,
    disposeSharedResultPanel,
    mountSharedResultPanelIfConfigured,
    normalizeSharedColumns,
    normalizeSharedResultSet,
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
