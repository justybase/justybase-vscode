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
            context.commandCancelPromise = Promise.resolve().then(() => command.cancel());
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
    if (error instanceof ExportCancelledError) {
        return true;
    }
    const candidate = error as { code?: unknown; errorNum?: unknown; message?: unknown } | null;
    const code = String(candidate?.code ?? '');
    const errorNum = String(candidate?.errorNum ?? '');
    const message = String(candidate?.message ?? error ?? '').toLowerCase();
    return code === EXPORT_CANCELLED_CODE
        || errorNum === '1013'
        || /ora-01013|cancel(?:led|ed)|user requested interrupt|operation aborted|aborterror/.test(message);
}

export function isTimeoutError(error: unknown): boolean {
    const candidate = error as { code?: unknown; message?: unknown } | null;
    const code = String(candidate?.code ?? '').toLowerCase();
    const message = String(candidate?.message ?? error ?? '').toLowerCase();
    return code.includes('timeout') || /timed? out|timeout|ora-01013.*timeout/.test(message);
}
