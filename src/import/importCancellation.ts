/**
 * Cooperative cancellation for import execution.
 *
 * Import drivers accept a lightweight predicate rather than an AbortSignal so
 * the webview/host boundary can abort a long-running load without the runtime
 * holding a subscription. Callers must check it between row/batch operations;
 * a `true` result means the import must stop as soon as it is safe to do so.
 */
export type ImportCancellationCheck = () => boolean;

/** Thrown when an import is aborted through the cancellation predicate. */
export class ImportCancelledError extends Error {
    public constructor(message = 'Import cancelled.') {
        super(message);
        this.name = 'ImportCancelledError';
    }
}

export function throwIfImportCancelled(isCancelled?: ImportCancellationCheck): void {
    if (isCancelled?.()) {
        throw new ImportCancelledError();
    }
}
