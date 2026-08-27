import * as vscode from 'vscode';

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
    retired: boolean;
}

const runningSources = new Map<string, ActiveExecution>();
const acquisitionLocks = new Map<string, Promise<void>>();
let documentKeys = new WeakMap<vscode.TextDocument, string>();
let retiredDocuments = new WeakSet<vscode.TextDocument>();
let nextDocumentKey = 0;
let nextExecutionId = 0;

function describeSource(sourceUri: string): string {
    if (sourceUri.startsWith('untitled:')) {
        return 'this untitled SQL tab';
    }

    const normalized = sourceUri.replace(/\\/g, '/');
    const filename = normalized.split('/').pop();
    return filename || 'this SQL tab';
}

function getSourceKey(sourceUri: string, document?: vscode.TextDocument): string {
    const uriKey = normalizeUriKey(sourceUri);
    if (!document) {
        return uriKey;
    }

    let documentKey = documentKeys.get(document);
    if (!documentKey) {
        documentKey = `${uriKey}#document-${++nextDocumentKey}`;
        documentKeys.set(document, documentKey);
    }
    return documentKey;
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

function isCurrent(entry: ActiveExecution): boolean {
    return !entry.retired && runningSources.get(entry.sourceKey)?.executionId === entry.executionId;
}

function retire(entry: ActiveExecution): void {
    entry.retired = true;
    const current = runningSources.get(entry.sourceKey);
    if (current?.executionId === entry.executionId) {
        runningSources.delete(entry.sourceKey);
    }
}

async function withAcquisitionLock<T>(sourceKey: string, callback: () => Promise<T>): Promise<T> {
    const previous = acquisitionLocks.get(sourceKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
        release = resolve;
    });
    const tail = previous.then(() => current);
    acquisitionLocks.set(sourceKey, tail);

    await previous;
    try {
        return await callback();
    } finally {
        release();
        if (acquisitionLocks.get(sourceKey) === tail) {
            acquisitionLocks.delete(sourceKey);
        }
    }
}

async function forceRecover(entry: ActiveExecution, useDropSession: boolean): Promise<boolean> {
    if (!isCurrent(entry)) {
        return true;
    }
    entry.phase = 'cancelling';
    try {
        await entry.recovery?.requestCancel?.();

        // If cancellation already finished the old lease, DROP SESSION is no
        // longer needed. The connection reset and abort cleanup below are still
        // mandatory before granting the retry.
        if (useDropSession && isCurrent(entry)) {
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
        if (isCurrent(entry)) {
            retire(entry);
        }
        return true;
    } catch {
        return false;
    }
}

async function openFreshConnection(entry: ActiveExecution): Promise<boolean> {
    if (!isCurrent(entry)) {
        return true;
    }
    entry.phase = 'cancelling';
    try {
        await entry.recovery?.requestCancel?.();
        if (!(await entry.recovery?.openFreshConnection?.())) {
            return false;
        }

        entry.recovery?.clearCancellation?.();
        if (isCurrent(entry)) {
            retire(entry);
        }
        return true;
    } catch {
        return false;
    }
}

async function offerFreshConnection(entry: ActiveExecution, reason: string): Promise<boolean> {
    if (!entry.recovery?.openFreshConnection) {
        void vscode.window.showErrorMessage(`${reason} Reconnect this tab manually before retrying.`);
        return false;
    }

    const selected = await vscode.window.showWarningMessage(
        `${reason} Open a fresh connection for this tab and retry? The previous session may continue until the server cleans it up.`,
        'Open new connection & retry',
        'Keep Waiting',
    );
    if (!isCurrent(entry)) {
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
    if (!isCurrent(entry)) {
        return false;
    }
    if (confirmed !== 'Open new connection & retry') {
        return false;
    }

    const recovered = await openFreshConnection(entry);
    if (!recovered) {
        void vscode.window.showErrorMessage('Could not open a fresh connection. The previous execution remains protected.');
    }
    return recovered;
}

async function offerDropSessionAfterForceFailure(entry: ActiveExecution): Promise<boolean> {
    const sessionId = entry.recovery?.getSessionId?.();
    if (!sessionId || !entry.recovery?.dropSession) {
        return offerFreshConnection(
            entry,
            'Could not reset the previous SQL execution safely and no session is available to drop.',
        );
    }

    const selected = await vscode.window.showWarningMessage(
        'Force unlock could not reset the previous SQL execution safely. Try DROP SESSION before retrying?',
        'Drop session & retry',
        'Keep Waiting',
    );
    if (!isCurrent(entry)) {
        return false;
    }
    if (selected !== 'Drop session & retry') {
        return false;
    }

    if (await forceRecover(entry, true)) {
        return true;
    }

    return offerFreshConnection(
        entry,
        'DROP SESSION did not terminate the previous SQL session.',
    );
}

async function resolveDuplicate(
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
    if (!isCurrent(entry)) {
        return false;
    }
    if (selected === 'Cancel current operation') {
        entry.phase = 'cancelling';
        await entry.recovery?.requestCancel?.();
        return false;
    }
    if (selected === 'Drop session & retry') {
        const recovered = await forceRecover(entry, true);
        if (!recovered) {
            return offerFreshConnection(
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
    if (!isCurrent(entry)) {
        return false;
    }
    if (confirmed !== 'Force unlock & retry') {
        return false;
    }

    const recovered = await forceRecover(entry, false);
    if (!recovered) {
        return offerDropSessionAfterForceFailure(entry);
    }
    return recovered;
}

function createLease(entry: ActiveExecution): QueryExecutionLease {
    return {
        executionId: entry.executionId,
        sourceUri: entry.sourceUri,
        sourceKey: entry.sourceKey,
        origin: entry.origin,
        isCurrent: () => isCurrent(entry),
        markRunning: () => {
            if (isCurrent(entry)) {
                entry.phase = 'running';
            }
        },
        markCancelling: () => {
            if (isCurrent(entry)) {
                entry.phase = 'cancelling';
            }
        },
        setRecovery: recovery => {
            if (isCurrent(entry)) {
                entry.recovery = recovery;
            }
        },
        dispose: () => retire(entry),
    };
}

/**
 * Acquires the per-document query lease. A TextDocument identity is deliberately
 * part of the key: VS Code can reuse textual untitled URIs after a tab closes.
 */
export async function tryAcquireQueryExecution(
    sourceUri: string,
    resultPanelProvider: Pick<ResultPanelView, 'log' | 'getActiveSource'>,
    options: QueryExecutionAcquireOptions = {},
): Promise<QueryExecutionLease | undefined> {
    const sourceKey = getSourceKey(sourceUri, options.document);
    return withAcquisitionLock(sourceKey, async () => {
        if (options.document && retiredDocuments.has(options.document)) {
            return undefined;
        }

        while (true) {
            const existing = runningSources.get(sourceKey);
            if (!existing || !isCurrent(existing)) {
                break;
            }
            if (!(await resolveDuplicate(existing, sourceUri, resultPanelProvider))) {
                return undefined;
            }
        }

        if (options.document && retiredDocuments.has(options.document)) {
            return undefined;
        }

        const entry: ActiveExecution = {
            executionId: `query-execution-${++nextExecutionId}`,
            sourceUri,
            sourceKey,
            origin: options.origin ?? 'Run Query',
            startedAt: Date.now(),
            phase: 'preparing',
            recovery: options.recovery,
            retired: false,
        };
        runningSources.set(sourceKey, entry);
        return createLease(entry);
    });
}

/** Mark a closed document's lease stale so a new document reusing its URI cannot inherit it. */
export function retireQueryExecutionForDocument(document: vscode.TextDocument): void {
    retiredDocuments.add(document);
    const sourceUri = document.uri.toString();
    const sourceKey = getSourceKey(sourceUri, document);
    const entry = runningSources.get(sourceKey);
    if (!entry || !isCurrent(entry)) {
        return;
    }

    entry.phase = 'cancelling';
    retire(entry);
    void entry.recovery?.requestCancel?.();
}

/**
 * Restore a document identity reopened by VS Code's language-mode lifecycle.
 * A genuinely reopened editor receives a new TextDocument identity, so deleting
 * that new object from the WeakSet cannot revive a delayed command from the
 * document that was actually closed.
 */
export function restoreQueryExecutionForReopenedDocument(document: vscode.TextDocument): void {
    retiredDocuments.delete(document);
}

export function isQueryExecutionRunning(sourceUri: string): boolean {
    const normalizedUri = normalizeUriKey(sourceUri);
    return Array.from(runningSources.values()).some(entry =>
        isCurrent(entry) && normalizeUriKey(entry.sourceUri) === normalizedUri,
    );
}

export function markQueryExecutionCancelling(sourceUri: string): void {
    const normalizedUri = normalizeUriKey(sourceUri);
    for (const entry of runningSources.values()) {
        if (isCurrent(entry) && normalizeUriKey(entry.sourceUri) === normalizedUri) {
            entry.phase = 'cancelling';
        }
    }
}

export function clearQueryExecutionGateForTests(): void {
    runningSources.clear();
    acquisitionLocks.clear();
    documentKeys = new WeakMap<vscode.TextDocument, string>();
    retiredDocuments = new WeakSet<vscode.TextDocument>();
    nextDocumentKey = 0;
    nextExecutionId = 0;
}
