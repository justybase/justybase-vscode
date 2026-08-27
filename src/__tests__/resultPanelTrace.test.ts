import {
    clearResultPanelTrace,
    getResultPanelTraceSnapshot,
    sanitizeResultPanelTraceEvent,
    traceResultPanelEvent,
} from '../views/resultPanelTrace';

describe('ResultPanelTrace', () => {
    const previousFlag = process.env.JUSTYBASE_RESULT_PANEL_TRACE;

    afterEach(() => {
        clearResultPanelTrace();
        if (previousFlag === undefined) {
            delete process.env.JUSTYBASE_RESULT_PANEL_TRACE;
        } else {
            process.env.JUSTYBASE_RESULT_PANEL_TRACE = previousFlag;
        }
    });

    it('does not collect diagnostics unless explicitly enabled', () => {
        delete process.env.JUSTYBASE_RESULT_PANEL_TRACE;

        traceResultPanelEvent({ phase: 'should_not_be_recorded', sourceUri: 'untitled:Untitled-1' });

        expect(getResultPanelTraceSnapshot()).toEqual([]);
    });

    it('keeps a bounded, ordered trace without row or SQL payloads', () => {
        process.env.JUSTYBASE_RESULT_PANEL_TRACE = '1';

        for (let index = 0; index < 2_005; index += 1) {
            traceResultPanelEvent({
                phase: 'append_streaming_chunk',
                sourceUri: 'untitled:Untitled-1',
                rowCount: 1,
                totalRows: index + 1,
            });
        }

        const trace = getResultPanelTraceSnapshot();
        expect(trace).toHaveLength(2_000);
        expect(trace[0]?.seq).toBe(6);
        expect(trace[trace.length - 1]?.seq).toBe(2_005);
        expect(trace[0]).not.toHaveProperty('rows');
        expect(trace[0]).not.toHaveProperty('sql');
    });

    it('whitelists and bounds fields received from the webview', () => {
        const event = sanitizeResultPanelTraceEvent({
            phase: 'x'.repeat(1000),
            sourceUri: 'untitled:Untitled-1',
            sql: 'SELECT secret',
            rows: [['secret']],
            error: 'e'.repeat(1000),
        });

        expect(event.phase).toHaveLength(256);
        expect(event).not.toHaveProperty('error');
        expect(event).not.toHaveProperty('sql');
        expect(event).not.toHaveProperty('rows');
    });
});
