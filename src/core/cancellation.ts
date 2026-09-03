import type { DatabaseCommand, DatabaseDataReader } from '@justybase/contracts';

export const EXPORT_CANCELLED_CODE = 'EXPORT_CANCELLED' as const;

/** A cancellation that deliberately leaves the already-written output in place. */
export class ExportCancelledError extends Error {
    public readonly code = EXPORT_CANCELLED_CODE;
    public readonly partial = true;

    public constructor(
        public readonly filePath: string,
        public readonly rowsWritten: number,
        message = `Export cancelled after ${rowsWritten.toLocaleString()} rows`,
    ) {
        super(message);
        this.name = 'ExportCancelledError';
    }
}

export type OperationStatus = 'success' | 'cancelled' | 'timeout' | 'error';

export interface CancellationCleanupContext {
    timeoutMs?: number;
    /** Internal state is intentionally kept on the context so repeated calls are safe. */
    cleanupPromise?: Promise<CancellationCleanupResult>;
    commandCancelPromise?: Promise<void>;
    readerClosePromise?: Promise<void>;
}

export interface CancellationCleanupResult {
    cancelError?: unknown;
    closeError?: unknown;
    timedOut: boolean;
}

function isKnownCancellationMessage(message: string): boolean {
    const normalized = message.trim().replace(/^error:\s*/iu, '');
    return /^(?:cancelled|canceled)(?:\s*[:;,-]\s*.+)?\.?$/iu.test(normalized)
        || /^(?:the\s+)?(?:query|statement|command|operation|request|execution)(?:\s+\w+)*\s+(?:was\s+)?cancel(?:led|ed)\b/iu.test(normalized)
        || /^cancel(?:l?ing|led|ed)\s+statement\s+due\s+to\s+user\s+request\b/iu.test(normalized)
        || /^query\s+execution\s+was\s+interrupted\b/iu.test(normalized)
        || /^user\s+(?:cancelled|canceled)\b/iu.test(normalized)
        || /^user\s+requested\s+interrupt\b/iu.test(normalized)
        || /^variable\s+(?:prompt|input)\s+cancel(?:led|ed)\b/iu.test(normalized)
        || /^(?:the\s+)?operation\s+(?:was\s+)?aborted\b/iu.test(normalized)
        || /^aborterror\b/iu.test(normalized);
}

const DEFAULT_READER_CLOSE_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * Cancels a command and closes its reader exactly once. It is safe to call
 * before executeReader() has produced a reader and safe to call concurrently.
 */
export async function cancelCommandAndCloseReader(
    command: DatabaseCommand | undefined,
    reader: DatabaseDataReader | undefined,
    context: CancellationCleanupContext = {},
): Promise<CancellationCleanupResult> {
    if (context.cleanupPromise && reader && !context.readerClosePromise) {
        await context.cleanupPromise;
        context.cleanupPromise = undefined;
    } else if (context.cleanupPromise) {
        return context.cleanupPromise;
    }

    const cleanup = (async (): Promise<CancellationCleanupResult> => {
        let cancelError: unknown;
        let closeError: unknown;
        let timedOut = false;

        if (command && !context.commandCancelPromise) {
            const timeoutMs = context.timeoutMs ?? DEFAULT_READER_CLOSE_TIMEOUT_MS;
            context.commandCancelPromise = withTimeout(
                Promise.resolve().then(() => command.cancel()),
                timeoutMs,
                `command.cancel() timed out after ${timeoutMs}ms`,
            );
        }
        if (context.commandCancelPromise) {
            try {
                await context.commandCancelPromise;
            } catch (error) {
                cancelError = error;
            }
        }

        if (reader && !context.readerClosePromise) {
            context.readerClosePromise = withTimeout(
                Promise.resolve().then(() => reader.close()),
                context.timeoutMs ?? DEFAULT_READER_CLOSE_TIMEOUT_MS,
                `reader.close() timed out after ${context.timeoutMs ?? DEFAULT_READER_CLOSE_TIMEOUT_MS}ms`,
            );
        }
        if (context.readerClosePromise) {
            try {
                await context.readerClosePromise;
            } catch (error) {
                closeError = error;
                timedOut = error instanceof Error && error.message.includes('timed out');
            }
        }

        return { cancelError, closeError, timedOut };
    })();

    context.cleanupPromise = cleanup;
    return cleanup;
}

export function isCancellationError(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
        if (current instanceof ExportCancelledError) {
            return true;
        }

        const candidate = current as {
            code?: unknown;
            errorNum?: unknown;
            message?: unknown;
            name?: unknown;
            cause?: unknown;
        };
        const code = String(candidate.code ?? '').toUpperCase();
        const name = String(candidate.name ?? '').toUpperCase();
        if (
            code === EXPORT_CANCELLED_CODE
            || code === 'ABORT_ERR'
            || code === 'ERR_CANCELED'
            || code === 'ECANCELED'
            || code === 'QUERY_CANCELED'
            || code === 'QUERY_CANCELLED'
            || code === 'REQUEST_CANCELED'
            || code === 'REQUEST_CANCELLED'
            || code === 'ERR_ABORTED'
            || code === 'CANCELED'
            || code === 'CANCELLED'
            || name === 'ABORTERROR'
        ) {
            return true;
        }
        if (String(candidate.errorNum ?? '') === '1013') {
            return true;
        }

        const message = typeof candidate.message === 'string'
            ? candidate.message
            : current instanceof Error
                ? current.message
                : typeof current === 'string'
                    ? current
                    : '';
        if (isKnownCancellationMessage(message) || /^ORA-01013\b/iu.test(message.trim())) {
            return true;
        }
        current = candidate.cause;
    }
    return false;
}

export function isTimeoutError(error: unknown): boolean {
    const candidate = error as { code?: unknown; message?: unknown } | null;
    const code = String(candidate?.code ?? '').toLowerCase();
    const message = String(candidate?.message ?? error ?? '').toLowerCase();
    return code.includes('timeout') || /timed? out|timeout|ora-01013.*timeout/.test(message);
}
