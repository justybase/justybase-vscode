import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import { normalizeUriKey } from '../../core/queryRunnerUtils';
import type { ResultPanelView } from '../../views/resultPanelView';

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
}

export interface QueryExecutionLease extends vscode.Disposable {
    readonly executionId: string;
    readonly sourceUri: string;
    readonly sourceKey: string;
    readonly origin: string;
    isCurrent(): boolean;
    markRunning(): void;
    markCancelling(): void;
    setRecovery(recovery: QueryExecutionRecovery): void;
}

interface ActiveExecution {
    executionId: string;
    sourceUri: string;
    sourceKey: string;
    origin: string;
    startedAt: number;
    phase: QueryExecutionPhase;
    recovery?: QueryExecutionRecovery;
    recoveryError?: unknown;
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
                this.retire(entry);
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
                this.retire(entry);
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
        resultPanelProvider: Pick<ResultPanelView, 'log' | 'getActiveSource'>,
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
            sourceUri: entry.sourceUri,
            sourceKey: entry.sourceKey,
            origin: entry.origin,
            isCurrent: () => this.isCurrent(entry),
            markRunning: () => {
                if (this.isCurrent(entry)) {
                    entry.phase = 'running';
                }
            },
            markCancelling: () => {
                if (this.isCurrent(entry)) {
                    entry.phase = 'cancelling';
                }
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
        resultPanelProvider: Pick<ResultPanelView, 'log' | 'getActiveSource'>,
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

            while (true) {
                const existing = this.runningSources.get(sourceKey);
                if (!existing || !this.isCurrent(existing)) {
                    break;
                }
                if (!(await this.resolveDuplicate(existing, sourceUri, resultPanelProvider))) {
                    return undefined;
                }
            }

            if (this.disposed || (options.document && this.retiredDocuments.has(options.document))) {
                return undefined;
            }

            const entry: ActiveExecution = {
                executionId: `query-execution-${++this.nextExecutionId}-${randomUUID()}`,
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
        const sourceUri = document.uri.toString();
        const documentKey = this.documentKeys.get(document);
        const entries = documentKey
            ? [this.runningSources.get(documentKey)]
            : [this.runningSources.get(normalizeUriKey(sourceUri))];
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
            this.isCurrent(entry) && normalizeUriKey(entry.sourceUri) === normalizedUri,
        );
    }

    public markCancelling(sourceUri: string): void {
        const normalizedUri = normalizeUriKey(sourceUri);
        for (const entry of this.runningSources.values()) {
            if (this.isCurrent(entry) && normalizeUriKey(entry.sourceUri) === normalizedUri) {
                entry.phase = 'cancelling';
            }
        }
    }

    /** Cancel and retire all leases during extension shutdown. */
    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
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
        this.runningSources.clear();
        this.acquisitionLocks.clear();
        this.documentKeys = new WeakMap<vscode.TextDocument, string>();
        this.retiredDocuments = new WeakSet<vscode.TextDocument>();
        this.nextDocumentKey = 0;
        this.nextExecutionId = 0;
        this.disposed = false;
    }
}

let defaultCoordinator = new QueryExecutionCoordinator();

/** Create the coordinator owned by one extension activation. */
export function createQueryExecutionCoordinator(): QueryExecutionCoordinator {
    return new QueryExecutionCoordinator();
}

/** Install an activation-owned coordinator behind the legacy command facade. */
export function setDefaultQueryExecutionCoordinator(coordinator: QueryExecutionCoordinator): void {
    const previous = defaultCoordinator;
    defaultCoordinator = coordinator;
    if (previous !== coordinator) previous.dispose();
}

export async function tryAcquireQueryExecution(
    sourceUri: string,
    resultPanelProvider: Pick<ResultPanelView, 'log' | 'getActiveSource'>,
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

export function markQueryExecutionCancelling(sourceUri: string): void {
    defaultCoordinator.markCancelling(sourceUri);
}

export function clearQueryExecutionGateForTests(): void {
    defaultCoordinator.clearForTests();
}
