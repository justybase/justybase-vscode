import { encode } from '@msgpack/msgpack';
import '@testing-library/jest-dom';
import { act } from 'react';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import {
    SharedResultPanelApp,
    SharedResultPanelController,
    decodeSharedRows,
    displaySharedRows,
    disposeSharedResultPanel,
    buildSharedFilterState,
    mountSharedResultPanel,
    normalizeSharedColumns,
    normalizeSharedResultSet,
    sharedAnalysisQuerySpec,
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
    document.body.innerHTML = '';
    document.head.querySelectorAll('#justybase-shared-result-panel-styles').forEach(node => node.remove());
});

describe('shared VS Code Result Panel adapter', () => {
    it('normalizes host payloads and applies filtering and sorting without leaking buffers to ui-core', () => {
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
            sql: 'SELECT ID FROM PEOPLE',
            refreshSql: 'SELECT * FROM PEOPLE',
        });
        expect(normalized).toMatchObject({
            resultSetId: 'result-1',
            totalRowCount: 2,
            rows: [[2], [1]],
            sql: 'SELECT ID FROM PEOPLE',
            refreshSql: 'SELECT * FROM PEOPLE',
        });
        expect(normalizeSharedResultSet({ data: [], columns: [], sql: 42, refreshSql: '' })?.sql).toBeUndefined();
        expect(normalizeSharedResultSet({ data: [], columns: [], sql: 42, refreshSql: '' })?.refreshSql).toBeUndefined();
        expect(normalizeSharedResultSet(null)).toBeUndefined();
        expect(normalizeSharedResultSet({ data: 'bad', columns: 'bad', isError: true })).toMatchObject({
            rows: [],
            columns: [],
            isError: true,
            totalRowCount: 0,
        });

        // Backend diagnostics survive normalization, and malformed payloads are
        // dropped instead of reaching the shared store.
        expect(normalizeSharedResultSet({
            data: [],
            columns: [],
            isError: true,
            message: 'relation "MISSING" does not exist',
            errorDetails: { code: '42P01', severity: 'ERROR', detail: 'Missing relation.', hint: 'Check the name.' },
        })).toMatchObject({
            isError: true,
            errorDetails: { code: '42P01', severity: 'ERROR', detail: 'Missing relation.', hint: 'Check the name.' },
        });
        expect(normalizeSharedResultSet({
            data: [],
            columns: [],
            isError: true,
            errorDetails: { code: 42, detail: null },
        })?.errorDetails).toBeUndefined();
        expect(normalizeSharedResultSet({
            data: [],
            columns: [],
            isError: true,
            errorDetails: 'not-an-object',
        })?.errorDetails).toBeUndefined();

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

    it('records, previews, discards and saves pending edits for editable results', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'result-editable',
                columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
                data: [[1, 'one']],
                totalRowCount: 1,
                isEditable: true,
                editSource: { db: 'DEV', schema: 'ADMIN', table: 'PEOPLE' },
            },
            {
                resultSetId: 'result-read-only',
                columns: [{ name: 'id', type: 'INTEGER' }],
                data: [[1]],
                totalRowCount: 1,
                isEditable: false,
                editDisabledReason: 'The query does not select a single table.',
            },
        ], 0));

        const editable = controller.activeResult();
        expect(controller.getEditInfo(editable)).toEqual({
            isEditable: true,
            editSource: { db: 'DEV', schema: 'ADMIN', table: 'PEOPLE' },
            reason: undefined,
        });
        expect(controller.isEditMode()).toBe(false);
        controller.toggleEditMode(editable);
        expect(controller.isEditMode()).toBe(true);

        controller.recordCellEdit(editable!, {
            rowIndex: 0,
            columnIndex: 1,
            oldValue: 'one',
            newValue: 'two',
        });
        expect(controller.getPendingEditCount(editable)).toBe(1);
        expect(controller.getRows(editable)).toEqual([[1, 'two']]);

        controller.discardEdits(editable);
        expect(controller.getPendingEditCount(editable)).toBe(0);
        expect(controller.getRows(editable)).toEqual([[1, 'one']]);
        controller.toggleEditMode(editable);
        expect(controller.isEditMode()).toBe(false);

        controller.selectResult('result-read-only');
        const readOnly = controller.activeResult();
        expect(controller.getEditInfo(readOnly)).toMatchObject({
            isEditable: false,
            reason: 'The query does not select a single table.',
        });
        controller.toggleEditMode(readOnly);
        expect(controller.isEditMode()).toBe(false);

        // Hydration starts a fresh session, matching the DOM grid.
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'result-read-only',
            columns: [{ name: 'id', type: 'INTEGER' }],
            data: [[2]],
            totalRowCount: 1,
        }]));
        expect(controller.isEditMode()).toBe(false);
        controller.dispose();
    });

    it('labels the Logs result and reports selection statistics for tabular results', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'logs-result',
                columns: [{ name: 'Time' }, { name: 'Message' }],
                data: [['12:00', 'ready']],
                totalRowCount: 1,
                isLog: true,
            },
            {
                resultSetId: 'stats-result',
                columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
                data: [[1, 'one'], [2, 'two']],
                totalRowCount: 2,
            },
        ], 1));

        const results = controller.getState().results.byResultSetId;
        const logs = Object.values(results).find(result => result.resultSetId === 'logs-result');
        const data = Object.values(results).find(result => result.resultSetId === 'stats-result');
        expect(controller.isLogResult(logs)).toBe(true);
        expect(controller.getResultLabel(logs!)).toBe('Logs');
        expect(controller.getResultLabel(data!)).toBeUndefined();

        expect(controller.calculateSelectionStats(data, {
            anchorRow: 0,
            anchorColumn: 0,
            focusRow: 1,
            focusColumn: 0,
        })).toEqual({
            cellCount: 2,
            type: 'numeric',
            count: 2,
            distinctCount: 2,
            sum: 3,
            min: 1,
            max: 2,
        });

        expect(controller.calculateSelectionStats(data, {
            anchorRow: 0,
            anchorColumn: 0,
            focusRow: 0,
            focusColumn: 0,
            additionalRanges: [{ minRow: 1, maxRow: 1, minColumn: 1, maxColumn: 1 }],
        })).toMatchObject({
            cellCount: 2,
            type: 'mixed',
            count: 2,
            distinctCount: 2,
        });

        controller.updateView('stats-result', { grouping: ['label'] });
        expect(controller.calculateSelectionStats(controller.activeResult(), {
            anchorRow: 0,
            anchorColumn: 0,
            focusRow: 0,
            focusColumn: 0,
        })).toBeNull();
        controller.dispose();
    });

    it('renders the Logs tab without editing or analysis controls', () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'logs-result',
                columns: [{ name: 'Time' }, { name: 'Message' }],
                data: [
                    ['12:00', 'ready'],
                    ['12:01', '✓ SUCCESS: SELECT 1'],
                    ['12:02', `✗ ERROR: SELECT 1 | CONN | 10 ms | 1 row | ERROR:  'SELECT ${Array.from({ length: 80 }, (_value, index) => `COL_${index}`).join(', ')} FROM T'\nerror ^ found "," (at char 10) expecting an identifier`],
                ],
                totalRowCount: 3,
                isLog: true,
            },
            {
                resultSetId: 'data-result',
                columns: [{ name: 'id', type: 'INTEGER' }],
                data: [[1]],
                totalRowCount: 1,
                isEditable: true,
                editSource: { table: 'PEOPLE' },
            },
        ], 1));
        render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
        expect(screen.getByRole('button', { name: 'Clear Logs' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit data' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Group' })).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Filter results' })).not.toBeInTheDocument();
        expect(screen.getByRole('log', { name: 'Query log' })).toHaveTextContent('ready');
        // Idle Logs must not claim work in progress.
        expect(document.querySelector('.ui-log-running')).toBeNull();
        expect(document.querySelector('.ui-result-tab-busy')).toBeNull();
        const errorHint = document.querySelector('.log-error-hint')?.textContent ?? '';
        expect(errorHint).toContain('found "," (at char 10)');
        expect(errorHint).not.toContain('COL_40');
        controller.dispose();
    });

    it('shows the running indicator on the Logs tab and header while SQL executes', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([
            {
                resultSetId: 'logs-running',
                columns: [{ name: 'Time' }, { name: 'Message' }],
                data: [['12:00', '▶ RUNNING: SELECT * FROM BIG_TABLE', { executionId: 'run', event: 'start', status: 'running', sql: 'SELECT * FROM BIG_TABLE' }]],
                totalRowCount: 1,
                isLog: true,
            },
        ], 0, ['file:///query.sql']));
        render(<SharedResultPanelApp controller={controller} />);

        // The Logs tab carries the animated tab spinner and reports aria-busy.
        const logsTab = screen.getByRole('tab', { name: 'Logs' });
        expect(logsTab).toHaveAttribute('aria-busy', 'true');
        expect(logsTab.querySelector('.ui-result-tab-spinner')).not.toBeNull();

        // The Logs header shows a dedicated running chip with the elapsed time
        // and a Cancel action, because the generic execution banner is not
        // rendered for the Logs surface. The only animated ring in the view is
        // the Logs tab header; the chip and transcript badges stay static.
        expect(screen.getByRole('button', { name: 'Clear Logs' })).toBeInTheDocument();
        const runningChip = document.querySelector('.ui-log-running');
        expect(runningChip).not.toBeNull();
        expect(runningChip).toHaveTextContent('Running…');
        expect(runningChip?.querySelector('.ui-activity-spinner')).toBeNull();
        expect(runningChip?.querySelector('.ui-log-running-elapsed')).not.toBeNull();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(document.querySelectorAll('.ui-activity-spinner')).toHaveLength(1);
        expect(document.querySelector('.log-status--running .log-status-icon-spinner')).toBeNull();
        expect(document.querySelector('.log-status--running .log-status-icon')?.textContent).toBe('▶');

        // Cancelling switches the chip label until the host acknowledges it.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(document.querySelector('.ui-log-running-cancelling')).not.toBeNull();
        expect(document.querySelector('.ui-log-running')).toHaveTextContent('Cancelling…');

        await act(async () => {
            controller.handleHostMessage({ command: 'setActiveSource', sourceUri: 'file:///query.sql', activeResultSetIndex: 0, executingSourcesJson: '[]', sourcesJson: '["file:///query.sql"]', pinnedSourcesJson: '[]' });
        });
        await waitFor(() => expect(document.querySelector('.ui-log-running')).toBeNull());
        await waitFor(() => expect(document.querySelector('.ui-result-tab-busy')).toBeNull());
        controller.dispose();
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
        // The redundant file-name header was removed from the shared panel.
        expect(screen.queryByRole('heading', { name: 'query.sql' })).not.toBeInTheDocument();
        expect(screen.getByRole('tablist', { name: 'Result sets' })).toBeInTheDocument();
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(screen.getByText('one')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter results' }), { target: { value: 'two' } });
        expect(screen.queryByText('one')).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter results' }), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open filter for label' }));
        fireEvent.change(screen.getByRole('combobox', { name: 'Filter condition for label' }), { target: { value: 'contains' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter value for label' }), { target: { value: 'one' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(screen.getByText('one')).toBeInTheDocument();
        expect(screen.queryByText('two')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Group by label' }));
        expect(screen.getByText(/1 rows/)).toBeInTheDocument();
        expect(controller.activeResult()?.view).toMatchObject({
            columnFilterDefinitions: { label: { operator: 'contains', value: 'one' } },
            grouping: ['label'],
        });
        // Groups arrive collapsed; opening the band reveals its single row.
        fireEvent.click(screen.getByRole('button', { name: 'Expand group label: one' }));
        const selectedCell = screen.getByRole('cell', { name: 'one' });
        fireEvent.mouseDown(selectedCell, { button: 0 });
        expect(selectedCell).toHaveClass('ui-data-grid-cell-selected');
        fireEvent.click(screen.getByRole('button', { name: 'Open filter for label' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
        fireEvent.click(screen.getByTitle(/^Sort by id\./));
        // Clearing the filter keeps the already-open band, so only the second
        // group needs expanding before its row can be clicked.
        fireEvent.click(screen.getByRole('button', { name: 'Expand group label: two' }));
        fireEvent.click(screen.getByRole('row', { name: '2 two' }));
        expect(screen.queryByRole('heading', { name: 'Row details' })).not.toBeInTheDocument();
        controller.dispose();
    });

    it('jumps to a searched column from the columns sidebar', () => {
        const controller = new SharedResultPanelController();
        const columns = ['ID', 'CUSTOMER_NAME', 'AMOUNT', 'REGION', 'CHANNEL', 'STATUS'].map(name => ({ name }));
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'column-finder-result',
            columns,
            data: [[1, 'Ada', 10, 'EU', 'WEB', 'ready']],
            totalRowCount: 1,
        }]));
        const { container } = render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle column sidebar' }));
        const finder = screen.getByRole('textbox', { name: 'Find column' });

        // The legacy More menu shortcut opens and focuses the sidebar field.
        fireEvent.click(screen.getByRole('button', { name: 'More result actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /Find column/ }));
        expect(document.activeElement).toBe(finder);

        fireEvent.change(finder, { target: { value: 'channel' } });
        fireEvent.keyDown(finder, { key: 'Enter' });
        const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
        expect(scroller?.scrollLeft ?? 0).toBeGreaterThan(0);
        expect(finder).toHaveValue('channel');
        controller.dispose();
    });

    it('reorders result columns by dragging in the columns sidebar', () => {
        const controller = new SharedResultPanelController();
        const columns = ['ID', 'CUSTOMER_NAME', 'AMOUNT', 'REGION'].map(name => ({ name }));
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'column-reorder-result',
            columns,
            data: [[1, 'Ada', 10, 'EU']],
            totalRowCount: 1,
        }]));
        const { container } = render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle column sidebar' }));
        const items = Array.from(container.querySelectorAll<HTMLElement>('.ui-column-sidebar-list li'));
        expect(items.map(item => item.getAttribute('data-sidebar-column-index'))).toEqual(['0', '1', '2', '3']);

        fireEvent.dragStart(items[1]!);
        fireEvent.drop(items[0]!);
        expect(controller.activeResult()?.view.columnOrder).toEqual(['CUSTOMER_NAME', 'ID', 'AMOUNT', 'REGION']);
        expect(Array.from(container.querySelectorAll<HTMLElement>('.ui-column-sidebar-list li')).map(item => item.getAttribute('data-sidebar-column-index')))
            .toEqual(['1', '0', '2', '3']);
        controller.dispose();
    });

    it('unhides and jumps to a searched hidden column', async () => {
        const controller = new SharedResultPanelController();
        const columns = ['ID', 'CUSTOMER_NAME', 'AMOUNT', 'REGION', 'CHANNEL', 'STATUS'].map(name => ({ name }));
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'hidden-column-result',
            columns,
            data: [[1, 'Ada', 10, 'EU', 'WEB', 'ready']],
            totalRowCount: 1,
        }]));
        controller.updateView('hidden-column-result', { columnVisibility: { CHANNEL: false } });
        const { container } = render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle column sidebar' }));
        const finder = screen.getByRole('textbox', { name: 'Find column' });

        fireEvent.change(finder, { target: { value: 'channel' } });
        expect(screen.getByRole('button', { name: 'CHANNEL' }).closest('li')).toHaveClass('is-hidden');
        fireEvent.keyDown(finder, { key: 'Enter' });

        await waitFor(() => expect(controller.activeResult()?.view.columnVisibility?.CHANNEL).toBeUndefined());
        const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
        await waitFor(() => expect(scroller?.scrollLeft ?? 0).toBeGreaterThan(0));
        controller.dispose();
    });

    it('toggles Excel-style footer aggregates and configures a column summary', () => {
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
        const { container } = render(<SharedResultPanelApp controller={controller} />);

        // The toolbar action toggles sums on numeric columns as footer rows.
        fireEvent.click(screen.getByRole('button', { name: 'Aggregate' }));
        const aggregateRow = container.querySelector<HTMLElement>('.ui-data-grid-aggregation-row-bottom');
        expect(aggregateRow?.textContent).toContain('Σ');
        expect(aggregateRow?.textContent).toContain('17');
        fireEvent.click(screen.getByRole('button', { name: 'Aggregate' }));
        expect(container.querySelector('.ui-data-grid-aggregation-row')).toBeNull();

        // The column menu exposes the same aggregate through the Filter/Summary toggle.
        fireEvent.click(screen.getByRole('button', { name: 'Open filter for AMOUNT' }));
        expect(screen.getByRole('dialog', { name: 'Filter AMOUNT' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));
        fireEvent.click(screen.getByRole('checkbox', { name: /Average/ }));
        expect(controller.activeResult()?.view.columnAggregations).toMatchObject({ AMOUNT: [{ fn: 'avg', position: 'bottom' }] });
        fireEvent.click(screen.getByRole('checkbox', { name: /Sum/ }));
        expect(controller.activeResult()?.view.columnAggregations).toMatchObject({ AMOUNT: [{ fn: 'avg', position: 'bottom' }, { fn: 'sum', position: 'bottom' }] });
        fireEvent.click(screen.getByRole('checkbox', { name: /Sum/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Top' }));
        expect(controller.activeResult()?.view.columnAggregations).toMatchObject({ AMOUNT: [{ fn: 'avg', position: 'top' }] });
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('dialog', { name: 'Filter AMOUNT' })).not.toBeInTheDocument();
        controller.dispose();
    });

    it('edits a cell through the shared panel and exposes the pending save action', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'editable-result',
            columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
            data: [[1, 'one']],
            totalRowCount: 1,
            isEditable: true,
            editSource: { db: 'DEV', schema: 'ADMIN', table: 'PEOPLE' },
        }]));
        render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Edit data' }));
        fireEvent.doubleClick(screen.getByRole('cell', { name: 'one' }));
        const editor = screen.getByRole('textbox', { name: 'Edit label' });
        fireEvent.change(editor, { target: { value: 'two' } });
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(await screen.findByRole('cell', { name: 'two' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(await screen.findByRole('cell', { name: 'one' })).toBeInTheDocument();
        controller.dispose();
    });

    it('builds Excel-style filter state from loaded rows and column definitions', () => {
        const request = {
            columnIndex: 1,
            column: { name: 'label', type: 'VARCHAR' },
            anchor: { left: 20, bottom: 40, width: 80, height: 20 } as DOMRect,
        };
        const view = {
            globalFilter: '',
            columnFilters: {},
            sorting: [],
            grouping: [],
            scrollTop: 0,
            scrollLeft: 0,
        };
        const rows = [[1, 'Beta'], [2, 'Alpha'], [3, 'Alpha'], [4, null]];
        const all = buildSharedFilterState(request, rows, view);
        expect(all.options.map(option => option.label)).toEqual(['Alpha', 'Beta']);
        expect(all.selectedKeys).toHaveLength(2);
        expect(all.operator).toBe('in');

        const contains = buildSharedFilterState(request, rows, {
            ...view,
            columnFilterDefinitions: { label: { operator: 'contains', value: 'Al' } },
        });
        expect(contains.operator).toBe('contains');
        expect(contains.value).toBe('Al');

        const selected = buildSharedFilterState(request, rows, {
            ...view,
            columnFilterDefinitions: { label: { operator: 'in', value: '', values: ['Beta'] } },
        });
        expect(selected.selectedKeys).toEqual(['"Beta"']);
    });

    it('applies and clears the Excel-style column filter from the shared panel', async () => {
        const controller = new SharedResultPanelController();
        controller.handleHostMessage(hydrateMessage([{
            resultSetId: 'filter-result',
            columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'VARCHAR' }],
            data: [[1, 'one'], [2, 'two']],
            totalRowCount: 2,
        }]));
        render(<SharedResultPanelApp controller={controller} />);
        fireEvent.click(screen.getByRole('button', { name: 'Open filter for label' }));
        expect(screen.getByRole('dialog', { name: 'Filter label' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('combobox', { name: 'Filter condition for label' }), { target: { value: 'contains' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Filter value for label' }), { target: { value: 'tw' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(screen.queryByRole('cell', { name: 'one' })).toBeNull();
        expect(await screen.findByRole('cell', { name: 'two' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Open filter for label' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
        expect(await screen.findByRole('cell', { name: 'one' })).toBeInTheDocument();
        expect(screen.getByRole('cell', { name: 'two' })).toBeInTheDocument();
        controller.dispose();
    });

    it('mounts the shared panel, consumes host messages, and cleans up idempotently', async () => {
        document.body.innerHTML = '<div id="shared-ui-root" style="display:none"></div>';
        act(() => {
            expect(mountSharedResultPanel()).toBe(true);
        });
        expect(document.body).toHaveClass('shared-ui-mode');
        expect(document.getElementById('shared-ui-root')).toHaveStyle({ display: 'block' });
        expect(document.getElementById('justybase-shared-result-panel-styles')).not.toBeNull();
        expect(mountSharedResultPanel()).toBe(true);
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
