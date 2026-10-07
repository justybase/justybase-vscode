describe('result panel protocol', () => {
    beforeEach(() => {
        jest.resetModules();
        delete (global as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    });

    it('falls back when acquireVsCodeApi throws during module initialization', () => {
        (global as typeof globalThis & { acquireVsCodeApi?: () => never }).acquireVsCodeApi = () => {
            throw new Error('boom');
        };

        const protocol: {
            getHostState: () => unknown;
            setHostState: (state: unknown) => void;
            postHostMessage: (message: { command: string }) => void;
        } = require('../../media/resultPanel/protocol.js');

        expect(protocol.getHostState()).toBeUndefined();
        expect(() => protocol.setHostState({ activeSource: 'file:///demo.sql' })).not.toThrow();
        expect(() => protocol.postHostMessage({ command: 'ready' })).not.toThrow();
    });

    it('rejects unknown and malformed host messages before they reach handlers', () => {
        const protocol: {
            asHostMessage: (message: unknown) => unknown;
        } = require('../../media/resultPanel/protocol.js');

        expect(protocol.asHostMessage({ command: 'executeSql', sql: 'SELECT 1' })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'appendRows', resultSetIndex: 0 })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'switchToResultSet', resultSetIndex: -1 })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'switchToResultSet', resultSetIndex: 1 })).toEqual({
            command: 'switchToResultSet',
            resultSetIndex: 1,
        });
    });

    it('validates webview messages at the shared host boundary', () => {
        const runtime: {
            parseResultPanelWebviewMessage: (message: unknown) => unknown;
        } = require('../contracts/webviews/resultPanelRuntime');

        expect(runtime.parseResultPanelWebviewMessage({ command: 'closeSource' })).toBeUndefined();
        expect(runtime.parseResultPanelWebviewMessage({ command: 'unknown' })).toBeUndefined();
        expect(runtime.parseResultPanelWebviewMessage({
            command: 'requestResultSync',
            sourceUri: 'untitled:demo',
            reason: 'missing-shell',
        })).toEqual({
            command: 'requestResultSync',
            sourceUri: 'untitled:demo',
            reason: 'missing-shell',
        });
        expect(runtime.parseResultPanelWebviewMessage({
            command: 'openRelatedRows',
            sourceUri: 'file:///demo.sql',
            resultSetIndex: 0,
            rowIndex: 2,
            columnIndex: 1,
        })).toEqual({
            command: 'openRelatedRows',
            sourceUri: 'file:///demo.sql',
            resultSetIndex: 0,
            rowIndex: 2,
            columnIndex: 1,
        });
        expect(runtime.parseResultPanelWebviewMessage({
            command: 'openRelatedRows', sourceUri: 'file:///demo.sql', resultSetIndex: 0, rowIndex: -1, columnIndex: 1,
        })).toBeUndefined();
    });

    it('accepts empty display text when inserting an empty SQL string literal', () => {
        const runtime: {
            parseResultPanelWebviewMessage: (message: unknown) => unknown;
        } = require('../contracts/webviews/resultPanelRuntime');

        expect(runtime.parseResultPanelWebviewMessage({
            command: 'insertCellContent',
            text: '',
            dataType: 'text',
            sqlText: "''",
        })).toEqual({
            command: 'insertCellContent',
            text: '',
            dataType: 'text',
            sqlText: "''",
        });
        expect(runtime.parseResultPanelWebviewMessage({
            command: 'insertCellContent',
            text: null,
            sqlText: "''",
        })).toBeUndefined();
    });

    it('accepts every declared command when its required payload is present', () => {
        const runtime: {
            parseResultPanelWebviewMessage: (message: unknown) => unknown;
            parseResultPanelHostMessage: (message: unknown) => unknown;
        } = require('../contracts/webviews/resultPanelRuntime');
        const contracts: {
            RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS: readonly string[];
            RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS: readonly string[];
        } = require('../contracts/webviews/resultPanelContracts');
        expect(contracts.RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS).toContain('openRelatedRows');

        const messageFixture = {
            sourceUri: 'untitled:result-panel',
            resultSetIndex: 0,
            requestId: 1,
            executionTimestamp: 1000,
            totalRows: 2,
            currentRows: 2,
            offset: 0,
            limit: 100,
            rowIndex: 0,
            columnIndex: 0,
            rows: [[1]],
            isLastChunk: true,
            limitReached: false,
            action: 'window',
            aggregations: [{ columnIndex: 0, fn: 'count' }],
            grouping: { groupByColumns: [], functions: [] },
            pivot: {
                rowColumnIndexes: [],
                columnColumnIndex: 0,
                valueColumnIndex: 0,
                aggFn: 'count',
            },
            pivotValues: [],
            composer: { bucketColumnIndex: 0, measureColumnIndex: 0 },
            filters: { dimensions: [], dates: [], measures: [] },
            data: { sourceUri: 'untitled:result-panel', mdDocument: 'table' },
            format: 'csv',
            destination: '/tmp/result.csv',
            scope: 'global',
            settings: {},
            text: 'status',
            reason: 'test',
            key: 'resultPanel.focused',
            value: true,
            resultId: 'result-1',
            stats: null,
            errorMessage: 'error',
            sql: 'SELECT 1',
            sourceKey: 'lane-1',
            lanesJson: '[]',
            editSource: { table: 'demo' },
            edits: [],
            fontFamily: 'monospace',
            fontSize: 12,
            dataUrl: 'data:image/png;base64,AA==',
            metrics: {
                durationMs: 1,
                activeSource: 'untitled:result-panel',
                resultSetCount: 1,
                totalRowCount: 1,
                executionState: 'success',
            },
            event: { phase: 'test', op: 'test' },
            ok: true,
            active: true,
            activeResultSetIndex: 0,
            executingSourcesJson: '[]',
            sourcesJson: '[]',
            pinnedSourcesJson: '[]',
            copyFormat: 'markdown',
            isLog: false,
            columns: [{ name: 'id' }],
            resultSetId: 'result-1',
            diskBackedStreamCapEnabled: false,
            filteredCount: 1,
            distinctValues: [],
            groupResult: { kind: 'groups', path: [], depth: 0, totalCount: 0, groups: [] },
            columnIndexes: { bucket: 0, dimension: undefined, split: undefined, measure: 0, previous: undefined },
            activeSourceJson: '"untitled:result-panel"',
            pinnedResultsJson: '[]',
            resultSetsMsgPack: new Uint8Array(),
            queryRowLimit: 100,
            maxDataResults: 100,
        };

        for (const command of contracts.RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS) {
            const parsed = runtime.parseResultPanelWebviewMessage({
                ...messageFixture,
                command,
                ...(command === 'testBridgeResult' ? { requestId: 'test-1', action: 'test' } : {}),
                ...(command === 'sqlQueueAction' ? { action: 'pause' } : {}),
            });
            if (!parsed) throw new Error(`invalid webview fixture: ${command}`);
        }
        for (const command of contracts.RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS) {
            const parsed = runtime.parseResultPanelHostMessage({
                ...messageFixture,
                command,
                ...(command === 'testBridge' ? { requestId: 'test-1', action: 'test' } : {}),
            });
            if (!parsed) throw new Error(`invalid host fixture: ${command}`);
        }

        expect(runtime.parseResultPanelWebviewMessage(null)).toBeUndefined();
        expect(runtime.parseResultPanelHostMessage({ command: 'not-a-command' })).toBeUndefined();
    });

    describe('adversarial payloads', () => {
        const loadRuntime = (): {
            parseResultPanelWebviewMessage: (message: unknown) => unknown;
            parseResultPanelHostMessage: (message: unknown) => unknown;
        } => require('../contracts/webviews/resultPanelRuntime');

        it.each([
            ['null', null],
            ['array', [1, 2, 3]],
            ['string', 'switchResultSet'],
            ['number', 42],
            ['boolean', true],
            ['function', () => undefined],
            ['command is a number', { command: 7 }],
            ['command is an object', { command: {} }],
            ['command is an array', { command: ['ready'] }],
            ['command is empty', { command: '' }],
        ])('rejects a non-record or non-string command (%s)', (_label, payload) => {
            expect(loadRuntime().parseResultPanelWebviewMessage(payload)).toBeUndefined();
            expect(loadRuntime().parseResultPanelHostMessage(payload)).toBeUndefined();
        });

        it.each([
            ['negative index', { command: 'switchToResultSet', resultSetIndex: -1 }],
            ['fractional index', { command: 'switchToResultSet', resultSetIndex: 1.5 }],
            ['NaN index', { command: 'switchToResultSet', resultSetIndex: Number.NaN }],
            ['infinite index', { command: 'switchToResultSet', resultSetIndex: Number.POSITIVE_INFINITY }],
            ['string index', { command: 'switchToResultSet', resultSetIndex: '0' }],
            ['missing source', { command: 'switchResultSet', resultSetIndex: 0 }],
            ['empty source', { command: 'switchSource', sourceUri: '' }],
            ['wrong-typed rows', { command: 'appendRows', resultSetIndex: 0, rows: 'not-rows' }],
            ['unknown format', { command: 'export', sourceUri: 'file:///a.sql', resultSetIndex: 0, format: 'exe' }],
            ['unknown aggregation action', { command: 'diskQuery', sourceUri: 'file:///a.sql', resultSetIndex: 0, requestId: 1, action: 'drop' }],
        ])('rejects a known command with an invalid payload (%s)', (_label, payload) => {
            expect(loadRuntime().parseResultPanelWebviewMessage(payload)).toBeUndefined();
        });

        it('rejects malformed host streaming payloads at the host boundary', () => {
            const runtime = loadRuntime();
            expect(runtime.parseResultPanelHostMessage({ command: 'appendRows', resultSetIndex: 0 })).toBeUndefined();
            expect(runtime.parseResultPanelHostMessage({ command: 'appendRows', resultSetIndex: 0, rows: [], totalRows: Number.NaN, isLastChunk: false, limitReached: false })).toBeUndefined();
            expect(runtime.parseResultPanelHostMessage({ command: 'appendRows', resultSetIndex: 1, rows: [[2]], totalRows: 1, isLastChunk: false, limitReached: false, workspace: 'yes' })).toBeUndefined();
            expect(runtime.parseResultPanelHostMessage({ command: 'streamingComplete', sourceUri: 'file:///a.sql', resultSetIndex: 1, totalRows: 1, limitReached: false, resultSetId: 'result-a', workspace: true })).toMatchObject({ workspace: true });
            expect(runtime.parseResultPanelHostMessage({ command: 'streamingComplete', sourceUri: 'file:///a.sql', resultSetIndex: 1, totalRows: 1, limitReached: false, workspace: 'yes' })).toBeUndefined();
            expect(runtime.parseResultPanelHostMessage({ command: 'copySelection', copyFormat: 'sql' })).toBeUndefined();
            expect(runtime.parseResultPanelHostMessage({ command: 'copySelection', copyFormat: 'markdown' })).toEqual({ command: 'copySelection', copyFormat: 'markdown' });
        });

        it('does not let an own __proto__ property pollute Object.prototype', () => {
            const runtime = loadRuntime();
            const payload = JSON.parse('{"command":"ready","__proto__":{"polluted":true}}') as Record<string, unknown>;
            const parsed = runtime.parseResultPanelWebviewMessage(payload) as Record<string, unknown>;

            expect(parsed.command).toBe('ready');
            expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        });
    });
});
