import * as vscode from 'vscode';
import { QueryExecutionCoordinator, type QueryExecutionLease, type QueryQueueOutcome } from '../commands/query/queryExecutionGate';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function document(uri = 'untitled:Untitled-1'): vscode.TextDocument {
    return { uri: { toString: () => uri } } as vscode.TextDocument;
}
function until(coordinator: QueryExecutionCoordinator, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise(resolve => {
        const listener = coordinator.onDidChange(() => {
            if (predicate()) { listener.dispose(); resolve(); }
        });
    });
}

describe('per-document execution queue', () => {
    let coordinator: QueryExecutionCoordinator;
    beforeEach(() => { coordinator = new QueryExecutionCoordinator(); });
    afterEach(() => coordinator.dispose());

    function enqueue(sql: string, doc: vscode.TextDocument, run: (lease: QueryExecutionLease) => Promise<QueryQueueOutcome>, recovery = {}) {
        return coordinator.enqueue({ sql, sourceUri: doc.uri.toString() }, { document: doc, recovery }, async () => run);
    }

    it('runs rapid submissions FIFO with only one active request and independent leases', async () => {
        const doc = document();
        const first = deferred<QueryQueueOutcome>();
        const order: string[] = [];
        const leases = new Set<string>();
        let active = 0;
        const jobs = ['A', 'B', 'C'].map(sql => enqueue(sql, doc, async lease => {
            leases.add(lease.executionId);
            expect(++active).toBe(1);
            order.push(sql);
            const result = sql === 'A' ? await first.promise : 'completed';
            --active;
            return result;
        }));
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        expect(order).toEqual(['A']);
        first.resolve('completed');
        expect(await Promise.all(jobs)).toEqual(['completed', 'completed', 'completed']);
        expect(order).toEqual(['A', 'B', 'C']);
        expect(leases.size).toBe(3);
    });

    it('reserves FIFO positions before asynchronous preparation completes', async () => {
        const doc = document();
        const prepare = deferred<(lease: QueryExecutionLease) => Promise<QueryQueueOutcome>>();
        const order: string[] = [];
        const first = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'A' }, { document: doc }, () => prepare.promise);
        const second = enqueue('B', doc, async () => { order.push('B'); return 'completed'; });
        await until(coordinator, () => coordinator.getSnapshot()[0]?.queued[1]?.status === 'queued');
        expect(order).toEqual([]);
        prepare.resolve(async () => { order.push('A'); return 'completed'; });
        await Promise.all([first, second]);
        expect(order).toEqual(['A', 'B']);
    });

    it('allows independent tabs to run concurrently', async () => {
        const finish = deferred<QueryQueueOutcome>();
        const a = enqueue('A', document('file:///a.sql'), () => finish.promise);
        const b = enqueue('B', document('file:///b.sql'), async () => 'completed');
        expect(await b).toBe('completed');
        expect(coordinator.getSnapshot().find(lane => lane.sourceUri.endsWith('a.sql'))?.running).toBeDefined();
        finish.resolve('completed');
        await a;
    });

    it('removes a queued item and clearing pending jobs does not cancel running SQL', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const cancel = jest.fn();
        const a = enqueue('A', doc, () => finish.promise, { requestCancel: cancel });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', doc, run);
        const c = enqueue('C', doc, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        const lane = coordinator.getSnapshot()[0];
        coordinator.removeQueued(lane.sourceKey, lane.queued[0].id);
        expect(await b).toBe('cancelled');
        expect(coordinator.getSnapshot()[0].queued.map(job => job.sql)).toEqual(['C']);
        coordinator.clearQueued(lane.sourceKey);
        expect(await c).toBe('cancelled');
        expect(cancel).not.toHaveBeenCalled();
        finish.resolve('completed');
        await a;
        expect(run).not.toHaveBeenCalled();
    });

    it('advances to the next queued request when a request fails', async () => {
        const doc = document();
        const a = enqueue('bad SQL', doc, async () => 'failed');
        const next = deferred<QueryQueueOutcome>();
        const run = jest.fn(() => next.promise);
        const b = enqueue('B', doc, run);
        expect(await a).toBe('failed');
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        const lane = coordinator.getSnapshot()[0];
        expect(lane.paused).toBe(false);
        expect(lane.last?.status).toBe('failed');
        expect(lane.last?.sql).toBe('bad SQL');
        next.resolve('completed');
        expect(await b).toBe('completed');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not advance on cancellation acknowledgement; waits for settlement and session isolation', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const isolate = deferred<boolean>();
        const cancel = jest.fn(async () => undefined);
        const a = enqueue('A', doc, () => finish.promise, { requestCancel: cancel, resetConnection: () => isolate.promise });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', doc, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        await coordinator.cancelRunning(coordinator.getSnapshot()[0].sourceKey);
        expect(coordinator.getSnapshot()[0].running?.status).toBe('cancelling');
        expect(run).not.toHaveBeenCalled();
        finish.resolve('cancelled');
        expect(run).not.toHaveBeenCalled();
        isolate.resolve(true);
        await Promise.all([a, b]);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('advances after cancellation even when the session could not be reset', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const a = enqueue('A', doc, () => finish.promise, { resetConnection: async () => false });
        const next = deferred<QueryQueueOutcome>();
        const run = jest.fn(() => next.promise);
        const b = enqueue('B', doc, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        finish.resolve('cancelled');
        expect(await a).toBe('cancelled');
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        const lane = coordinator.getSnapshot()[0];
        expect(lane.paused).toBe(false);
        expect(lane.last?.status).toBe('cancelled');
        expect(lane.last?.error).toContain('could not be reset');
        next.resolve('completed');
        expect(await b).toBe('completed');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('discards pending jobs on close and isolates reused untitled identities from stale completions', async () => {
        const old = document();
        const finish = deferred<QueryQueueOutcome>();
        const cancel = jest.fn(async () => undefined);
        const a = enqueue('A', old, () => finish.promise, { requestCancel: cancel });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', old, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        coordinator.retireForDocument(old);
        expect(await Promise.all([a, b])).toEqual(['cancelled', 'cancelled']);
        expect(await enqueue('C', document(), async () => 'completed')).toBe('completed');
        finish.resolve('completed');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(run).not.toHaveBeenCalled();
        expect(await enqueue('stale', old, run)).toBe('cancelled');
    });

    it('settles jobs and releases listeners on shutdown, including pending preparation', async () => {
        const doc = document();
        const preparation = deferred<(lease: QueryExecutionLease) => Promise<QueryQueueOutcome>>();
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const a = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'A' }, { document: doc }, () => preparation.promise);
        const b = enqueue('B', doc, run);
        const listener = jest.fn();
        coordinator.onDidChange(listener);
        coordinator.dispose();
        expect(await Promise.all([a, b])).toEqual(['cancelled', 'cancelled']);
        preparation.resolve(run);
        expect(coordinator.getSnapshot()).toEqual([]);
        expect(await enqueue('C', doc, run)).toBe('cancelled');
        expect(run).not.toHaveBeenCalled();
        coordinator.setPaused('missing', false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps captured SQL when the caller changes editor text', async () => {
        const doc = document();
        let text = 'SELECT * FROM CUSTOMER';
        coordinator.setPaused('missing', true);
        const prepare = deferred<(lease: QueryExecutionLease) => Promise<QueryQueueOutcome>>();
        const result = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: text }, { document: doc }, () => prepare.promise);
        text = 'DELETE FROM CUSTOMER';
        expect(text).toBe('DELETE FROM CUSTOMER');
        expect(coordinator.getSnapshot()[0].queued[0].sql).toBe('SELECT * FROM CUSTOMER');
        prepare.resolve(async () => 'completed');
        await result;
        expect(coordinator.getSnapshot()[0].last?.sql).toBe('SELECT * FROM CUSTOMER');
    });

    it('handles completion/enqueue/clear races without duplicate starts', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const a = enqueue('A', doc, () => finish.promise);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        finish.resolve('completed');
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', doc, run);
        coordinator.clearQueued(coordinator.getSnapshot()[0].sourceKey);
        const c = enqueue('C', doc, run);
        expect(await Promise.all([a, b, c])).toEqual(['completed', 'cancelled', 'completed']);
        expect(run).toHaveBeenCalledTimes(1);
    });
    it('aborts removed preparation and does not start prompts for jobs cleared synchronously', async () => {
        const doc = document();
        const prepare = jest.fn(async () => async (): Promise<QueryQueueOutcome> => 'completed');
        const job = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'A' }, { document: doc }, prepare);
        coordinator.clearQueued(coordinator.getSnapshot()[0].sourceKey);
        expect(await job).toBe('cancelled');
        await Promise.resolve();
        expect(prepare).not.toHaveBeenCalled();
    });

    it('safely recovers a stuck execution, continues automatically and ignores its late completion', async () => {
        const doc = document();
        const stuck = deferred<QueryQueueOutcome>();
        let oldLease: QueryExecutionLease | undefined;
        const a = enqueue('A', doc, lease => { oldLease = lease; return stuck.promise; }, {
            requestCancel: async () => undefined, resetConnection: async () => true,
        });
        const b = enqueue('B', doc, async () => 'completed');
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        const key = coordinator.getSnapshot()[0].sourceKey;
        const warning = jest.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValue('Force unlock & retry' as never);
        await coordinator.recoverRunning(key, { getActiveSource: () => undefined, log: () => undefined });
        expect(await a).toBe('cancelled');
        expect(oldLease?.isCurrent()).toBe(false);
        expect(coordinator.getSnapshot()[0].paused).toBe(false);
        expect(await b).toBe('completed');
        stuck.resolve('completed');
        expect(coordinator.getSnapshot()[0].last?.sql).toBe('B');
        warning.mockRestore();
    });

    it('does not resume while recovery confirmation is pending or cancel a replacement job', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const decision = deferred<string>();
        const requested = deferred<void>();
        const warning = jest.spyOn(vscode.window, 'showWarningMessage').mockImplementationOnce(() => {
            requested.resolve();
            return decision.promise as never;
        });
        const a = enqueue('A', doc, () => finish.promise, { resetConnection: async () => true });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', doc, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        const key = coordinator.getSnapshot()[0].sourceKey;
        const recovery = coordinator.recoverRunning(key, { getActiveSource: () => undefined, log: () => undefined });
        await requested.promise;
        finish.resolve('completed');
        await a;
        expect(run).not.toHaveBeenCalled();
        decision.resolve('Keep Waiting');
        await recovery;
        expect(coordinator.getSnapshot()[0].paused).toBe(false);
        expect(await b).toBe('completed');
        warning.mockRestore();
    });

    it('continues after preparation failures and cancelled input', async () => {
        const doc = document();
        const a = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'A' }, { document: doc }, async () => {
            throw new Error('Variable input cancelled by user');
        });
        const b = enqueue('B', doc, async () => 'completed');
        expect(await Promise.all([a, b])).toEqual(['cancelled', 'completed']);
        expect(coordinator.getSnapshot()[0].paused).toBe(false);
        const failed = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'broken include' }, { document: doc }, async () => {
            throw new Error('Include file unavailable');
        });
        expect(await failed).toBe('failed');
        expect(coordinator.getSnapshot()[0].last?.error).toBe('Include file unavailable');
        expect(await enqueue('C', doc, async () => 'completed')).toBe('completed');
        expect(coordinator.getSnapshot()[0].paused).toBe(false);
    });

    it('advances after a failed request even when session isolation cannot be verified', async () => {
        const doc = document();
        const a = enqueue('A', doc, async lease => { lease.requireSessionIsolation(); return 'failed'; },
            { resetConnection: async () => false });
        expect(await a).toBe('failed');
        const lane = coordinator.getSnapshot()[0];
        expect(lane.paused).toBe(false);
        expect(lane.running).toBeUndefined();
        expect(lane.last?.status).toBe('failed');
        expect(lane.last?.error).toContain('could not be reset');
    });

    it('does not attach the reset warning to a completed request', async () => {
        const doc = document();
        const a = enqueue('A', doc, async lease => { lease.requireSessionIsolation(); return 'completed'; },
            { resetConnection: async () => false });
        expect(await a).toBe('completed');
        const lane = coordinator.getSnapshot()[0];
        expect(lane.paused).toBe(false);
        expect(lane.last?.status).toBe('completed');
        expect(lane.last?.error).toBeUndefined();
    });

    it('does not park the lane when the cancellation request fails', async () => {
        const doc = document();
        const finish = deferred<QueryQueueOutcome>();
        const a = enqueue('A', doc, () => finish.promise, { requestCancel: async () => { throw new Error('cancel failed'); } });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const b = enqueue('B', doc, run);
        await until(coordinator, () => !!coordinator.getSnapshot()[0]?.running);
        await coordinator.cancelRunning(coordinator.getSnapshot()[0].sourceKey);
        expect(coordinator.getSnapshot()[0].paused).toBe(false);
        finish.resolve('completed');
        await Promise.all([a, b]);
        expect(run).toHaveBeenCalledTimes(1);
    });

});

describe('independent sessions in one SQL tab', () => {
    it('starts at most 20 independent requests and admits queued jobs FIFO as slots settle', async () => {
        const coordinator = new QueryExecutionCoordinator();
        const doc = document();
        const completions = Array.from({ length: 25 }, () => deferred<QueryQueueOutcome>());
        const order: number[] = [];
        let active = 0, peak = 0;
        const jobs = completions.map((completion, index) => coordinator.enqueue({ sourceUri: doc.uri.toString(), executionUri: `execution:${index}`, sql: `SELECT ${index}` },
            { document: doc, independentConnection: true }, async () => async lease => {
                peak = Math.max(peak, ++active); order.push(index); lease.markRunning();
                const result = await completion.promise; --active; lease.markSessionIsolated(); return result;
            }));
        await until(coordinator, () => order.length === 20);
        expect(coordinator.getSnapshot()).toHaveLength(1);
        expect(coordinator.getSnapshot()[0].runningExecutions).toHaveLength(20);
        expect(coordinator.getSnapshot()[0].queued).toHaveLength(5);
        completions[7].resolve('completed');
        await until(coordinator, () => order.length === 21);
        expect(order).toEqual(Array.from({ length: 21 }, (_, i) => i));
        expect(peak).toBe(20);
        const key = coordinator.getSnapshot()[0].sourceKey;
        coordinator.setPaused(key, true);
        completions[0].resolve('completed'); await jobs[0];
        expect(order).toHaveLength(21);
        coordinator.setPaused(key, false);
        await until(coordinator, () => order.length === 22);
        completions.forEach(completion => completion.resolve('completed'));
        expect(await Promise.all(jobs)).toEqual(Array(25).fill('completed'));
        expect(peak).toBe(20); coordinator.dispose();
    });
    it('cancels one independent request without invalidating sibling leases', async () => {
        const coordinator = new QueryExecutionCoordinator(); const doc = document();
        const finishA = deferred<QueryQueueOutcome>(), finishB = deferred<QueryQueueOutcome>();
        const cancelA = jest.fn(), cancelB = jest.fn(); let leaseB!: QueryExecutionLease;
        const a = coordinator.enqueue({ sourceUri: doc.uri.toString(), executionUri: 'execution:A', sql: 'A' }, { document: doc, independentConnection: true, recovery: { requestCancel: cancelA } }, async () => async lease => { const result = await finishA.promise; lease.markSessionIsolated(); return result; });
        const b = coordinator.enqueue({ sourceUri: doc.uri.toString(), executionUri: 'execution:B', sql: 'B' }, { document: doc, independentConnection: true, recovery: { requestCancel: cancelB } }, async () => async lease => { leaseB = lease; lease.markRunning(); return finishB.promise; });
        await until(coordinator, () => !!leaseB);
        const lane = coordinator.getSnapshot()[0];
        await coordinator.cancelRunning(lane.sourceKey, lane.runningExecutions.find(job => job.sql === 'A')!.id);
        expect(cancelA).toHaveBeenCalledTimes(1); expect(cancelB).not.toHaveBeenCalled(); expect(leaseB.isCurrent()).toBe(true);
        finishA.resolve('cancelled'); expect(await a).toBe('cancelled'); expect(leaseB.isCurrent()).toBe(true);
        finishB.resolve('completed'); expect(await b).toBe('completed'); coordinator.dispose();
    });
    it('pauses slot admission and document close discards pending jobs and retires every session', async () => {
        const coordinator = new QueryExecutionCoordinator(); const doc = document();
        const pending = deferred<QueryQueueOutcome>(); const cancelled = jest.fn();
        const jobs = Array.from({ length: 23 }, (_, i) => coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: `${i}` }, { document: doc, independentConnection: true, recovery: { requestCancel: cancelled } }, async () => () => pending.promise));
        await until(coordinator, () => coordinator.getSnapshot()[0]?.runningExecutions.length === 20);
        coordinator.setPaused(coordinator.getSnapshot()[0].sourceKey, true);
        coordinator.retireForDocument(doc);
        expect(await Promise.all(jobs)).toEqual(Array(23).fill('cancelled'));
        expect(cancelled).toHaveBeenCalledTimes(20); expect(coordinator.getSnapshot()).toEqual([]);
        pending.resolve('completed'); coordinator.dispose();
    });
});
