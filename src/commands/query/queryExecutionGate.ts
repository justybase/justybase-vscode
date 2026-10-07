import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import { isCancellationError } from '../../core/cancellation';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { normalizeUriKey } from '../../core/queryRunnerUtils';

export interface QueryExecutionResultPanel {
    updateSqlQueue?(lanesJson: string): void;
    getActiveSource(): string | undefined;
    log(sourceUri: string, message: string): void;
    cancelExecution?(sourceUri: string): void;
    finalizeExecution?(sourceUri: string): void;
}

export type QueryExecutionPhase = 'preparing' | 'running' | 'cancelling';

export interface QueryExecutionRecovery {
    /** Ask the current execution to stop before a reset or DROP SESSION. */
    requestCancel?: () => Promise<void>;
    /** Return the session belonging to this execution, if one is known. */
    getSessionId?: () => string | undefined;
    /** Terminates the stored Netezza session. Returns false when it was not terminated. */
    dropSession?: (sessionId: string) => Promise<boolean>;
    /** Disconnects the document session so a forced retry cannot reuse it. */
    resetConnection?: () => Promise<boolean>;
    /** Creates a fresh document connection after abandoning an unresponsive old one. */
    openFreshConnection?: () => Promise<boolean>;
    /** Clears an abort marker only after the old execution has been isolated. */
    clearCancellation?: () => void;
    /** False for operations whose non-database side effects cannot be safely superseded. */
    allowForcedRecovery?: boolean;
    forcedRecoveryUnavailableMessage?: string;
}

export interface QueryExecutionAcquireOptions {
    document?: vscode.TextDocument;
    origin?: string;
    recovery?: QueryExecutionRecovery;
    /** This request owns a new connection rather than the document session. */
    independentConnection?: boolean;
}

export interface QueryExecutionLease extends vscode.Disposable {
    readonly executionId: string;
    /** Real editor context; sourceUri remains the legacy execution identity. */
    readonly documentUri?: string;
    readonly executionUri?: string;
    readonly sourceUri: string;
    readonly sourceKey: string;
    readonly origin: string;
    isCurrent(): boolean;
    markRunning(): void;
    markCancelling(): void;
    setRecovery(recovery: QueryExecutionRecovery): void;
    disableForcedRecovery(message: string): void;
    recordError(message: string): void;
    requireSessionIsolation(): void;
    markSessionIsolated(): void;
}

export const MAX_INDEPENDENT_SQL_EXECUTIONS_PER_DOCUMENT = 4;
export type QuerySessionState = 'reusable' | 'closed' | 'unknown';

export function clampQueryParallelLimit(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.min(100, Math.trunc(value))) : fallback;
}

export type QueryQueueStatus = 'preparing' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type QueryQueueOutcome = 'completed' | 'failed' | 'cancelled';

export interface QueryQueueSnapshot {
    readonly id: string;
    readonly sourceUri: string;
    readonly sourceKey: string;
    readonly executionUri?: string;
    readonly sql: string;
    readonly connectionName?: string;
    readonly database?: string;
    readonly sourceRange?: vscode.Range;
    readonly queuedAt: number;
    readonly status: QueryQueueStatus;
    readonly error?: string;
    readonly sessionState?: QuerySessionState;
}

export interface QueryLaneSnapshot {
    readonly sourceKey: string;
    readonly sourceUri: string;
    readonly paused: boolean;
    readonly recoveryRequired?: boolean;
    readonly running?: QueryQueueSnapshot;
    readonly maxConcurrency: number;
    readonly runningExecutions: readonly QueryQueueSnapshot[];
    readonly queued: readonly QueryQueueSnapshot[];
    readonly last?: QueryQueueSnapshot;
}

interface QueueJob {
    snapshot: QueryQueueSnapshot;
    options: QueryExecutionAcquireOptions;
    preparation: AbortController;
    sequence: number;
    run?: (lease: QueryExecutionLease) => Promise<QueryQueueOutcome>;
    resolve: (outcome: QueryQueueOutcome) => void;
}

interface ExecutionLane {
    sourceKey: string;
    sourceUri: string;
    paused: boolean;
    running?: QueueJob;
    independent: Map<string, QueueJob>;
    queued: QueueJob[];
    last?: QueryQueueSnapshot;
    pumping?: boolean;
    recovering?: boolean;
    blockedSession?: ActiveExecution;
}

interface ActiveExecution {
    documentUri: string;
    laneKey?: string;
    executionId: string;
    sourceUri: string;
    sourceKey: string;
    origin: string;
    startedAt: number;
    phase: QueryExecutionPhase;
    recovery?: QueryExecutionRecovery;
    recoveryError?: unknown;
    error?: string;
    isolationRequired?: boolean;
    isolationVerified?: boolean;
    retired: boolean;
}

function describeSource(sourceUri: string): string {
    if (sourceUri.startsWith('untitled:')) {
        return 'this untitled SQL tab';
    }

    const normalized = sourceUri.replace(/\\/g, '/');
    const filename = normalized.split('/').pop();
    return filename || 'this SQL tab';
}

function getPhaseDescription(phase: QueryExecutionPhase): string {
    switch (phase) {
        case 'preparing':
            return 'is still preparing';
        case 'cancelling':
            return 'is being cancelled';
        default:
            return 'is already running';
    }
}

function getElapsedDescription(startedAt: number): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : '';
}

/**
 * Instance-owned desktop execution coordination.
 *
 * Query commands still use the small exported facade below, but mutable
 * leases, acquisition locks, and document identities belong to this object.
 * This makes activation and tests able to create isolated coordinators without
 * sharing an execution gate accidentally.
 */
export class QueryExecutionCoordinator {
    private readonly runningSources = new Map<string, ActiveExecution>();
    private readonly acquisitionLocks = new Map<string, Promise<void>>();
    private documentKeys = new WeakMap<vscode.TextDocument, string>();
    private retiredDocuments = new WeakSet<vscode.TextDocument>();
    private nextDocumentKey = 0;
    private nextExecutionId = 0;
    private disposed = false;
    private readonly lanes = new Map<string, ExecutionLane>();
    private readonly listeners = new Set<() => void>();

    private nextSubmission = 0;
    private perTabLimit = 4;
    private globalLimit = 12;

    public configureParallelLimits(perTab: unknown, global: unknown): void {
        this.perTabLimit = clampQueryParallelLimit(perTab, 4);
        this.globalLimit = clampQueryParallelLimit(global, 12);
        this.changed();
        this.pumpAll();
    }

    private pumpAll(): void {
        for (const lane of this.lanes.values()) this.pump(lane);
    }

    private nextEligibleJob(lane: ExecutionLane): QueueJob | undefined {
        // An unsafe shared session cannot block independently owned connections.
        return lane.blockedSession
            ? lane.queued.find(job => job.options.independentConnection)
            : lane.queued[0];
    }

    private canAdmit(lane: ExecutionLane, job: QueueJob): boolean {
        if (lane.paused || lane.recovering || !job.run) return false;
        if (!job.options.independentConnection) return !lane.blockedSession && !lane.running && !this.runningSources.has(lane.sourceKey);
        const total = [...this.lanes.values()].reduce((count, item) => count + item.independent.size, 0);
        return lane.independent.size < this.perTabLimit && total < this.globalLimit;
    }

    public onDidChange(listener: () => void): vscode.Disposable {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private changed(): void {
        for (const listener of this.listeners) {
            try { listener(); }
            catch (error: unknown) { console.error('SQL queue observer failed:', error); }
        }
    }

    public getSnapshot(): readonly QueryLaneSnapshot[] {
        return [...this.lanes.values()].map(lane => ({
            sourceKey: lane.sourceKey, sourceUri: lane.sourceUri, paused: lane.paused, recoveryRequired: !!lane.blockedSession,
            maxConcurrency: lane.independent.size || lane.queued.some(job => job.options.independentConnection) ? this.perTabLimit : 1,
            running: this.snapshotJob(lane.running ?? lane.independent.values().next().value),
            runningExecutions: [ ...(lane.running ? [lane.running] : []), ...lane.independent.values() ].map(job => this.snapshotJob(job)!),
            queued: lane.queued.map(job => ({ ...job.snapshot })),
            last: lane.last ? { ...lane.last } : undefined,
        }));
    }

    private snapshotJob(job?: QueueJob): QueryQueueSnapshot | undefined {
        if (!job) return undefined;
        const active = [...this.runningSources.values()].find(entry => entry.executionId === job.snapshot.id);
        return { ...job.snapshot, status: active?.phase ?? job.snapshot.status };
    }

    /** Reserve order synchronously, before any prompt or other asynchronous preparation. */
    public enqueue(
        snapshot: Omit<QueryQueueSnapshot, 'id' | 'sourceKey' | 'queuedAt' | 'status'>,
        options: QueryExecutionAcquireOptions,
        prepare: (signal: AbortSignal) => Promise<((lease: QueryExecutionLease) => Promise<QueryQueueOutcome>) | undefined>,
    ): Promise<QueryQueueOutcome> {
        if (this.disposed || (options.document && this.retiredDocuments.has(options.document))) {
            return Promise.resolve('cancelled');
        }
        const sourceKey = this.getSourceKey(snapshot.sourceUri, options.document);
        let lane = this.lanes.get(sourceKey);
        if (!lane) {
            lane = { sourceKey, sourceUri: snapshot.sourceUri, queued: [], independent: new Map(), paused: false };
            this.lanes.set(sourceKey, lane);
        }
        let resolve!: (outcome: QueryQueueOutcome) => void;
        const settled = new Promise<QueryQueueOutcome>(done => { resolve = done; });
        const job: QueueJob = {
            snapshot: Object.freeze({ ...snapshot, id: randomUUID(), sourceKey, queuedAt: Date.now(), status: 'preparing' }),
            options: Object.freeze({ ...options }), resolve, preparation: new AbortController(), sequence: ++this.nextSubmission,
        };
        lane.queued.push(job);
        this.changed();
        const owner = lane;
        void Promise.resolve().then(() => job.preparation.signal.aborted ? undefined : prepare(job.preparation.signal)).then(run => {
            if (!owner.queued.includes(job) || this.disposed) return;
            if (!run) {
                owner.queued.splice(owner.queued.indexOf(job), 1);
                job.resolve('cancelled');
                this.changed();
                this.pumpAll();
                return;
            }
            job.run = run;
            job.snapshot = { ...job.snapshot, status: 'queued' };
            this.changed();
            this.pumpAll();
        }, error => {
            if (!owner.queued.includes(job)) return;
            owner.queued.splice(owner.queued.indexOf(job), 1);
            const outcome = isCancellationError(error) ? 'cancelled' : 'failed';
            owner.last = { ...job.snapshot, status: outcome, error: error instanceof Error ? error.message : String(error) };
            job.resolve(outcome);
            this.changed();
            this.pumpAll();
        });
        return settled;
    }

    private pump(lane: ExecutionLane): void {
        if (this.disposed || this.lanes.get(lane.sourceKey) !== lane || lane.paused || lane.pumping || lane.recovering) return;
        const job = this.nextEligibleJob(lane);
        if (!job || !this.canAdmit(lane, job)) return;
        if (job.options.independentConnection) {
            const olderEligible = [...this.lanes.values()].some(other => {
                const candidate = this.nextEligibleJob(other);
                return candidate?.options.independentConnection && candidate.sequence < job.sequence && this.canAdmit(other, candidate);
            });
            if (olderEligible) return;
        }
        lane.pumping = true;
        void this.withAcquisitionLock(lane.sourceKey, async () => {
            lane.pumping = false;
            if (this.disposed || this.lanes.get(lane.sourceKey) !== lane || lane.paused || lane.recovering
                || this.nextEligibleJob(lane) !== job || !this.canAdmit(lane, job)) return undefined;
            if (job.options.independentConnection) lane.independent.set(job.snapshot.id, job);
            else lane.running = job;
            lane.queued.splice(lane.queued.indexOf(job), 1);
            const entry: ActiveExecution = {
                documentUri: lane.sourceUri, executionId: job.snapshot.id, sourceUri: job.snapshot.executionUri ?? lane.sourceUri,
                sourceKey: job.options.independentConnection ? `${lane.sourceKey}#execution:${job.snapshot.id}` : lane.sourceKey, laneKey: lane.sourceKey,
                origin: job.options.origin ?? 'Run Query', startedAt: Date.now(), phase: 'preparing',
                recovery: job.options.recovery, retired: false,
            };
            this.runningSources.set(entry.sourceKey, entry);
            return this.createLease(entry);
        }).then(async lease => {
            if (!lease) {
                if (!this.runningSources.has(lane.sourceKey)) this.pump(lane);
                return;
            }
            job.snapshot = { ...job.snapshot, status: 'running' };
            this.changed();
            if (job.options.independentConnection) this.pumpAll();
            let outcome: QueryQueueOutcome = 'failed';
            let errorMessage: string | undefined;
            try {
                outcome = await job.run!(lease);
            } catch (error: unknown) {
                outcome = isCancellationError(error) ? 'cancelled' : 'failed';
                errorMessage = error instanceof Error ? error.message : String(error);
            } finally {
                let isolated = false;
                const active = this.runningSources.get(lease.sourceKey);
                if (!job.options.independentConnection && lease.isCurrent() && !active?.isolationVerified && (outcome === 'cancelled' || active?.isolationRequired)) {
                    isolated = await this.withAcquisitionLock(lane.sourceKey, async () => {
                        if (!lease.isCurrent()) return true;
                        try { return await active?.recovery?.resetConnection?.() ?? false; }
                        catch { return false; }
                    });
                }
                if (this.lanes.get(lane.sourceKey) === lane && (lane.running === job || lane.independent.get(job.snapshot.id) === job)) {
                    if (lane.running === job) lane.running = undefined;
                    lane.independent.delete(job.snapshot.id);
                    const sessionState: QuerySessionState = active?.isolationVerified || (isolated && (outcome === 'cancelled' || active?.isolationRequired))
                        ? 'closed' : (outcome === 'cancelled' || active?.isolationRequired) ? 'unknown' : 'reusable';
                    if (sessionState === 'unknown' && !job.options.independentConnection && active) lane.blockedSession = active;
                    const isolationNote = sessionState === 'unknown'
                        ? job.options.independentConnection
                            ? 'Transient session cleanup could not be verified; sibling sessions remain independent.'
                            : 'Session could not be reset; recover the connection before running more SQL on this shared session.' : undefined;
                    const terminalError = [errorMessage ?? active?.error, isolationNote].filter(Boolean).join(' ');
                    lane.last = { ...job.snapshot, status: outcome, sessionState, ...(terminalError ? { error: terminalError } : {}) };
                    lease.dispose();
                    this.changed();
                    this.pumpAll();
                } else {
                    lease.dispose();
                }
                job.resolve(outcome);
            }
        });
    }

    public removeQueued(sourceKey: string, id: string): void {
        const lane = this.lanes.get(sourceKey);
        const index = lane?.queued.findIndex(job => job.snapshot.id === id) ?? -1;
        if (!lane || index < 0) return;
        const removed = lane.queued.splice(index, 1)[0];
        removed.preparation.abort();
        removed.resolve('cancelled');
        this.changed();
        this.pumpAll();
    }

    public clearQueued(sourceKey: string): void {
        const lane = this.lanes.get(sourceKey);
        if (!lane) return;
        for (const job of lane.queued.splice(0)) { job.preparation.abort(); job.resolve('cancelled'); }
        this.changed();
        this.pumpAll();
    }

    public setPaused(sourceKey: string, paused: boolean): void {
        const lane = this.lanes.get(sourceKey);
        if (!lane) return;
        lane.paused = paused;
        this.changed();
        this.pumpAll();
    }

    private activeInLane(sourceKey: string, id?: string): ActiveExecution | undefined {
        return [...this.runningSources.values()].find(entry => (entry.sourceKey === sourceKey || entry.laneKey === sourceKey) && (!id || entry.executionId === id));
    }

    public async cancelRunning(sourceKey: string, id?: string): Promise<void> {
        const entry = this.activeInLane(sourceKey, id);
        if (!entry || !this.isCurrent(entry)) return;
        entry.phase = 'cancelling';
        entry.isolationRequired = true;
        this.changed();
        // Sending cancellation is not completion. Only settlement releases the lane.
        try { await entry.recovery?.requestCancel?.(); }
        catch (error: unknown) {
            entry.recoveryError = error;
            this.changed();
        }
    }

    public async recoverRunning(sourceKey: string, panel: QueryExecutionResultPanel, id?: string): Promise<void> {
        const lane = this.lanes.get(sourceKey);
        if (lane?.blockedSession && (!id || id === lane.blockedSession.executionId)) {
            await this.recoverBlockedSession(lane, panel);
            return;
        }
        const entry = this.activeInLane(sourceKey, id);
        if (!entry) return;
        if (lane?.recovering) return;
        const oldJob = lane?.running?.snapshot.id === entry.executionId ? lane.running : lane?.independent.get(entry.executionId);
        if (lane) { lane.recovering = true; }
        this.changed();
        try {
            if (await this.withAcquisitionLock(sourceKey, () => this.resolveDuplicate(entry, entry.documentUri, panel))) {
                // Only the captured job can be detached; late completions must
                // never retire a replacement execution.
                if (lane && oldJob && (lane.running === oldJob || lane.independent.get(oldJob.snapshot.id) === oldJob)) {
                    oldJob.resolve('cancelled');
                    lane.last = { ...oldJob.snapshot, status: 'cancelled' };
                    if (lane.running === oldJob) lane.running = undefined;
                    lane.independent.delete(oldJob.snapshot.id);
                }
                panel.finalizeExecution?.(entry.sourceUri);
            }
        } catch (error: unknown) {
            entry.recoveryError = error;
            void vscode.window.showErrorMessage(`SQL recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (lane) { lane.recovering = false; }
            this.changed();
            if (lane) this.pumpAll();
        }
    }

    private async recoverBlockedSession(lane: ExecutionLane, panel: QueryExecutionResultPanel): Promise<void> {
        const blocked = lane.blockedSession;
        if (!blocked || lane.recovering) return;
        lane.recovering = true;
        this.changed();
        try {
            const actions = ['Reset connection', 'Open fresh connection'];
            if (blocked.recovery?.getSessionId?.() && blocked.recovery.dropSession) actions.push('Drop session');
            const choice = await vscode.window.showWarningMessage(
                'The previous request has settled, but its shared session is unsafe. Recover before continuing queued SQL.', ...actions);
            if (this.lanes.get(lane.sourceKey) !== lane || lane.blockedSession !== blocked) return;
            const recovered = await this.withAcquisitionLock(lane.sourceKey, async () => {
                if (choice === 'Reset connection') return await blocked.recovery?.resetConnection?.() ?? false;
                if (choice === 'Open fresh connection') return await blocked.recovery?.openFreshConnection?.() ?? false;
                if (choice === 'Drop session') {
                    const session = blocked.recovery?.getSessionId?.();
                    if (session && await blocked.recovery?.dropSession?.(session)) return await blocked.recovery?.resetConnection?.() ?? false;
                }
                return false;
            });
            if (recovered && this.lanes.get(lane.sourceKey) === lane && lane.blockedSession === blocked) {
                blocked.recovery?.clearCancellation?.();
                lane.blockedSession = undefined;
                panel.log(lane.sourceUri, 'Shared SQL connection recovered; queued requests can continue.');
            }
        } catch (error: unknown) {
            void vscode.window.showErrorMessage(`SQL recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            lane.recovering = false;
            this.changed();
            this.pumpAll();
        }
    }

    private getSourceKey(sourceUri: string, document?: vscode.TextDocument): string {
        const uriKey = normalizeUriKey(sourceUri);
        if (!document) {
            return uriKey;
        }

        let documentKey = this.documentKeys.get(document);
        if (!documentKey) {
            documentKey = `${uriKey}#document-${++this.nextDocumentKey}`;
            this.documentKeys.set(document, documentKey);
        }
        return documentKey;
    }

    private isCurrent(entry: ActiveExecution): boolean {
        return !entry.retired && this.runningSources.get(entry.sourceKey)?.executionId === entry.executionId;
    }

    private retire(entry: ActiveExecution): void {
        entry.retired = true;
        const current = this.runningSources.get(entry.sourceKey);
        if (current?.executionId === entry.executionId) {
            this.runningSources.delete(entry.sourceKey);
            const lane = this.lanes.get(entry.laneKey ?? entry.sourceKey);
            if (lane) this.pumpAll();
            this.changed();
        }
    }

    private async withAcquisitionLock<T>(sourceKey: string, callback: () => Promise<T>): Promise<T> {
        const previous = this.acquisitionLocks.get(sourceKey) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.acquisitionLocks.set(sourceKey, tail);

        await previous;
        try {
            return await callback();
        } finally {
            release();
            if (this.acquisitionLocks.get(sourceKey) === tail) {
                this.acquisitionLocks.delete(sourceKey);
            }
        }
    }

    private retireRecovered(entry: ActiveExecution): void {
        const lane = this.lanes.get(entry.laneKey ?? entry.sourceKey);
        const job = lane?.running?.snapshot.id === entry.executionId ? lane.running : lane?.independent.get(entry.executionId);
        if (lane && job?.snapshot.id === entry.executionId) {
            job.resolve('cancelled');
            lane.last = { ...job.snapshot, status: 'cancelled' };
            if (lane.running === job) lane.running = undefined;
            lane.independent.delete(job.snapshot.id);
        }
        this.retire(entry);
    }

    private async forceRecover(entry: ActiveExecution, useDropSession: boolean): Promise<boolean> {
        if (!this.isCurrent(entry)) {
            return true;
        }
        entry.phase = 'cancelling';
        try {
            await entry.recovery?.requestCancel?.();

            // If cancellation already finished the old lease, DROP SESSION is
            // no longer needed. The connection reset and abort cleanup below
            // are still mandatory before granting the retry.
            if (useDropSession && this.isCurrent(entry)) {
                const sessionId = entry.recovery?.getSessionId?.();
                if (!sessionId || !(await entry.recovery?.dropSession?.(sessionId))) {
                    return false;
                }
            }

            // A forced retry must never share a connection with a possibly-live command.
            if (!entry.recovery?.resetConnection || !(await entry.recovery.resetConnection())) {
                return false;
            }

            entry.recovery?.clearCancellation?.();
            if (this.isCurrent(entry)) {
                this.retireRecovered(entry);
            }
            return true;
        } catch (error: unknown) {
            entry.recoveryError = error;
            return false;
        }
    }

    private async openFreshConnection(entry: ActiveExecution): Promise<boolean> {
        if (!this.isCurrent(entry)) {
            return true;
        }
        entry.phase = 'cancelling';
        try {
            await entry.recovery?.requestCancel?.();
            if (!(await entry.recovery?.openFreshConnection?.())) {
                return false;
            }

            entry.recovery?.clearCancellation?.();
            if (this.isCurrent(entry)) {
                this.retireRecovered(entry);
            }
            return true;
        } catch (error: unknown) {
            entry.recoveryError = error;
            return false;
        }
    }

    private async offerFreshConnection(entry: ActiveExecution, reason: string): Promise<boolean> {
        if (!entry.recovery?.openFreshConnection) {
            void vscode.window.showErrorMessage(`${reason} Reconnect this tab manually before retrying.`);
            return false;
        }

        const selected = await vscode.window.showWarningMessage(
            `${reason} Open a fresh connection for this tab and retry? The previous session may continue until the server cleans it up.`,
            'Open new connection & retry',
            'Keep Waiting',
        );
        if (!this.isCurrent(entry)) {
            return false;
        }
        if (selected !== 'Open new connection & retry') {
            return false;
        }

        const confirmed = await vscode.window.showWarningMessage(
            'The old SQL session will be abandoned because it could not be terminated. Open a new connection for this tab and retry?',
            { modal: true },
            'Open new connection & retry',
        );
        if (!this.isCurrent(entry)) {
            return false;
        }
        if (confirmed !== 'Open new connection & retry') {
            return false;
        }

        const recovered = await this.openFreshConnection(entry);
        if (!recovered) {
            void vscode.window.showErrorMessage('Could not open a fresh connection. The previous execution remains protected.');
        }
        return recovered;
    }

    private async offerDropSessionAfterForceFailure(entry: ActiveExecution): Promise<boolean> {
        const sessionId = entry.recovery?.getSessionId?.();
        if (!sessionId || !entry.recovery?.dropSession) {
            return this.offerFreshConnection(
                entry,
                'Could not reset the previous SQL execution safely and no session is available to drop.',
            );
        }

        const selected = await vscode.window.showWarningMessage(
            'Force unlock could not reset the previous SQL execution safely. Try DROP SESSION before retrying?',
            'Drop session & retry',
            'Keep Waiting',
        );
        if (!this.isCurrent(entry)) {
            return false;
        }
        if (selected !== 'Drop session & retry') {
            return false;
        }

        if (await this.forceRecover(entry, true)) {
            return true;
        }

        return this.offerFreshConnection(
            entry,
            'DROP SESSION did not terminate the previous SQL session.',
        );
    }

    private async resolveDuplicate(
        entry: ActiveExecution,
        sourceUri: string,
        resultPanelProvider: QueryExecutionResultPanel,
    ): Promise<boolean> {
        const sessionId = entry.recovery?.getSessionId?.();
        const forcedRecoveryAllowed = entry.recovery?.allowForcedRecovery !== false
            && typeof entry.recovery?.resetConnection === 'function';
        const actions = forcedRecoveryAllowed
            ? ['Keep Waiting', 'Force unlock & retry']
            : ['Keep Waiting', 'Cancel current operation'];
        if (forcedRecoveryAllowed && sessionId && entry.recovery?.dropSession) {
            actions.splice(1, 0, 'Drop session & retry');
        }

        const unavailableSuffix = !forcedRecoveryAllowed && entry.recovery?.forcedRecoveryUnavailableMessage
            ? ` ${entry.recovery.forcedRecoveryUnavailableMessage}`
            : '';
        const message = `SQL execution ${getPhaseDescription(entry.phase)} for ${describeSource(sourceUri)}${getElapsedDescription(entry.startedAt)}.${unavailableSuffix}`;
        if (resultPanelProvider.getActiveSource() === sourceUri) {
            resultPanelProvider.log(sourceUri, message);
        }

        const selected = await vscode.window.showWarningMessage(message, ...actions);
        if (!this.isCurrent(entry)) {
            return false;
        }
        if (selected === 'Cancel current operation') {
            entry.phase = 'cancelling';
            await entry.recovery?.requestCancel?.();
            return false;
        }
        if (selected === 'Drop session & retry') {
            const recovered = await this.forceRecover(entry, true);
            if (!recovered) {
                return this.offerFreshConnection(
                    entry,
                    'DROP SESSION did not terminate the previous SQL session.',
                );
            }
            return recovered;
        }

        if (selected !== 'Force unlock & retry') {
            return false;
        }

        const confirmed = await vscode.window.showWarningMessage(
            'Force unlock will cancel the previous operation and reset this tab connection before retrying. Continue?',
            { modal: true },
            'Force unlock & retry',
        );
        if (!this.isCurrent(entry)) {
            return false;
        }
        if (confirmed !== 'Force unlock & retry') {
            return false;
        }

        const recovered = await this.forceRecover(entry, false);
        if (!recovered) {
            return this.offerDropSessionAfterForceFailure(entry);
        }
        return recovered;
    }

    private createLease(entry: ActiveExecution): QueryExecutionLease {
        return {
            executionId: entry.executionId,
            documentUri: entry.documentUri,
            executionUri: entry.sourceUri,
            sourceUri: entry.sourceUri,
            sourceKey: entry.sourceKey,
            origin: entry.origin,
            isCurrent: () => this.isCurrent(entry),
            markRunning: () => {
                if (this.isCurrent(entry)) {
                    entry.phase = 'running';
                    this.changed();
                }
            },
            markCancelling: () => {
                if (this.isCurrent(entry)) {
                    entry.phase = 'cancelling';
                    this.changed();
                }
            },
            disableForcedRecovery: message => {
                if (this.isCurrent(entry)) entry.recovery = { ...entry.recovery,
                    allowForcedRecovery: false, forcedRecoveryUnavailableMessage: message };
            },
            recordError: message => {
                if (this.isCurrent(entry)) entry.error = message;
            },
            markSessionIsolated: () => {
                if (this.isCurrent(entry)) entry.isolationVerified = true;
            },
            requireSessionIsolation: () => {
                if (this.isCurrent(entry)) entry.isolationRequired = true;
            },
            setRecovery: recovery => {
                if (this.isCurrent(entry)) {
                    entry.recovery = recovery;
                }
            },
            dispose: () => this.retire(entry),
        };
    }

    /**
     * Acquires the per-document query lease. A TextDocument identity is deliberately
     * part of the key: VS Code can reuse textual untitled URIs after a tab closes.
     */
    public async tryAcquire(
        sourceUri: string,
        resultPanelProvider: QueryExecutionResultPanel,
        options: QueryExecutionAcquireOptions = {},
    ): Promise<QueryExecutionLease | undefined> {
        if (this.disposed) {
            return undefined;
        }
        const sourceKey = this.getSourceKey(sourceUri, options.document);
        return this.withAcquisitionLock(sourceKey, async () => {
            if (this.disposed || (options.document && this.retiredDocuments.has(options.document))) {
                return undefined;
            }

            let recovered = false;
            while (true) {
                const existing = this.runningSources.get(sourceKey);
                if (!existing || !this.isCurrent(existing)) {
                    break;
                }
                if (!(await this.resolveDuplicate(existing, sourceUri, resultPanelProvider))) {
                    return undefined;
                }
                recovered = true;
            }

            if (this.disposed || (options.document && this.retiredDocuments.has(options.document))) {
                return undefined;
            }

            // A confirmed "retry" keeps the request the user explicitly asked
            // for: it may run ahead of SQL queued behind the recovered
            // execution, and the queue drains automatically once it settles.
            const lane = this.lanes.get(sourceKey);
            if (lane?.blockedSession) return undefined;
            if (!recovered && (lane?.running || (lane?.queued.length && !lane.paused))) return undefined;

            const entry: ActiveExecution = {
                executionId: `query-execution-${++this.nextExecutionId}-${randomUUID()}`,
                documentUri: sourceUri,
                sourceUri,
                sourceKey,
                origin: options.origin ?? 'Run Query',
                startedAt: Date.now(),
                phase: 'preparing',
                recovery: options.recovery,
                retired: false,
            };
            this.runningSources.set(sourceKey, entry);
            return this.createLease(entry);
        });
    }

    /** Mark a closed document's lease stale so a new document reusing its URI cannot inherit it. */
    public retireForDocument(document: vscode.TextDocument): void {
        this.retiredDocuments.add(document);
        const key = this.documentKeys.get(document) ?? normalizeUriKey(document.uri.toString());
        const lane = this.lanes.get(key);
        if (lane) {
            this.clearQueued(key);
            lane.running?.resolve('cancelled');
            for (const job of lane.independent.values()) job.resolve('cancelled');
            this.lanes.delete(key);
            this.changed();
        }
        const entries = [...this.runningSources.values()].filter(entry => entry.sourceKey === key || entry.laneKey === key);
        for (const entry of entries) {
            if (!entry || !this.isCurrent(entry)) continue;
            entry.phase = 'cancelling';
            this.retire(entry);
            void Promise.resolve(entry.recovery?.requestCancel?.()).catch(() => undefined);
        }
    }

    /** Restore a document identity reopened by VS Code's language-mode lifecycle. */
    public restoreForReopenedDocument(document: vscode.TextDocument): void {
        this.retiredDocuments.delete(document);
    }

    public isRunning(sourceUri: string): boolean {
        const normalizedUri = normalizeUriKey(sourceUri);
        return Array.from(this.runningSources.values()).some(entry =>
            this.isCurrent(entry) && (normalizeUriKey(entry.sourceUri) === normalizedUri || normalizeUriKey(this.lanes.get(entry.laneKey ?? entry.sourceKey)?.sourceUri ?? '') === normalizedUri),
        );
    }

    /**
     * True when a new SQL run for `sourceUri` overlaps with previous results
     * that are not fully completed. Covers both actively running executions
     * (`runningSources`) and jobs waiting in the per-tab queue (`preparing` /
     * `queued`, including the window where the predecessor has not acquired
     * its lease yet). Must be snapshotted synchronously before `enqueue()`,
     * because the queue serializes work: by the time the follow-up job's
     * `run()` starts, the predecessor has already finalized and `isRunning()`
     * alone would return false.
     */
    public hasPendingWork(sourceUri: string): boolean {
        if (this.isRunning(sourceUri)) {
            return true;
        }
        const normalizedUri = normalizeUriKey(sourceUri);
        for (const lane of this.lanes.values()) {
            if (normalizeUriKey(lane.sourceUri) !== normalizedUri) {
                continue;
            }
            if (lane.running || lane.queued.length > 0 || lane.independent.size > 0) {
                return true;
            }
        }
        return false;
    }

    public markCancelling(sourceUri: string): void {
        const normalizedUri = normalizeUriKey(sourceUri);
        for (const entry of this.runningSources.values()) {
            if (this.isCurrent(entry) && (normalizeUriKey(entry.sourceUri) === normalizedUri || normalizeUriKey(this.lanes.get(entry.laneKey ?? entry.sourceKey)?.sourceUri ?? '') === normalizedUri)) {
                entry.phase = 'cancelling';
                this.changed();
            }
        }
    }

    /** Cancel and retire all leases during extension shutdown. */
    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const lane of this.lanes.values()) {
            for (const job of lane.queued) { job.preparation.abort(); job.resolve('cancelled'); }
            lane.running?.resolve('cancelled');
            for (const job of lane.independent.values()) job.resolve('cancelled');
        }
        this.lanes.clear();
        this.changed();
        this.listeners.clear();
        const active = [...this.runningSources.values()];
        this.runningSources.clear();
        this.acquisitionLocks.clear();
        for (const entry of active) {
            entry.retired = true;
            entry.phase = 'cancelling';
            void Promise.resolve(entry.recovery?.requestCancel?.()).catch(() => undefined);
        }
    }

    /** Test-only reset; production callers should dispose an activation instance. */
    public clearForTests(): void {
        this.dispose();
        this.runningSources.clear();
        this.acquisitionLocks.clear();
        this.documentKeys = new WeakMap<vscode.TextDocument, string>();
        this.retiredDocuments = new WeakSet<vscode.TextDocument>();
        this.nextDocumentKey = 0;
        this.nextExecutionId = 0;
        this.nextSubmission = 0;
        this.disposed = false;
    }
}

let defaultCoordinator = new QueryExecutionCoordinator();

/** Create the coordinator owned by one extension activation. */
export function createQueryExecutionCoordinator(): QueryExecutionCoordinator {
    const coordinator = new QueryExecutionCoordinator();
    const refreshLimits = () => {
        const config = getExtensionConfiguration();
        coordinator.configureParallelLimits(config.get('query.maxParallelPerTab', 4), config.get('query.maxParallelGlobal', 12));
    };
    refreshLimits();
    const listener = vscode.workspace.onDidChangeConfiguration?.(event => {
        if (event.affectsConfiguration('justybase.query')) refreshLimits();
    });
    const dispose = coordinator.dispose.bind(coordinator);
    coordinator.dispose = () => { listener?.dispose(); dispose(); };
    return coordinator;
}

/** Install an activation-owned coordinator behind the legacy command facade. */
export function setDefaultQueryExecutionCoordinator(coordinator: QueryExecutionCoordinator): void {
    const previous = defaultCoordinator;
    defaultCoordinator = coordinator;
    if (previous !== coordinator) previous.dispose();
}

export async function tryAcquireQueryExecution(
    sourceUri: string,
    resultPanelProvider: QueryExecutionResultPanel,
    options: QueryExecutionAcquireOptions = {},
): Promise<QueryExecutionLease | undefined> {
    return defaultCoordinator.tryAcquire(sourceUri, resultPanelProvider, options);
}

/** Mark a closed document's lease stale so a new document reusing its URI cannot inherit it. */
export function retireQueryExecutionForDocument(document: vscode.TextDocument): void {
    defaultCoordinator.retireForDocument(document);
}

/** Restore a document identity reopened by VS Code's language-mode lifecycle. */
export function restoreQueryExecutionForReopenedDocument(document: vscode.TextDocument): void {
    defaultCoordinator.restoreForReopenedDocument(document);
}

export function isQueryExecutionRunning(sourceUri: string): boolean {
    return defaultCoordinator.isRunning(sourceUri);
}

export function hasPendingQueryExecution(sourceUri: string): boolean {
    return defaultCoordinator.hasPendingWork(sourceUri);
}

export function markQueryExecutionCancelling(sourceUri: string): void {
    defaultCoordinator.markCancelling(sourceUri);
}

export function clearQueryExecutionGateForTests(): void {
    defaultCoordinator.clearForTests();
}

/** Access the activation-owned queue for commands and its view. */
export function getQueryExecutionCoordinator(): QueryExecutionCoordinator {
    return defaultCoordinator;
}
