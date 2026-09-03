import {
    cancelCommandAndCloseReader,
    ExportCancelledError,
    isCancellationError,
} from '../core/cancellation';
import type { DatabaseCommand, DatabaseDataReader } from '@justybase/contracts';

describe('cancellation contract', () => {
    it('is idempotent and closes a reader supplied after the first cancel', async () => {
        const command = { cancel: jest.fn().mockResolvedValue(undefined) } as unknown as DatabaseCommand;
        const reader = { close: jest.fn().mockResolvedValue(undefined) } as unknown as DatabaseDataReader;
        const context = { timeoutMs: 50 };

        await cancelCommandAndCloseReader(command, undefined, context);
        await Promise.all([
            cancelCommandAndCloseReader(command, reader, context),
            cancelCommandAndCloseReader(command, reader, context),
        ]);

        expect(command.cancel).toHaveBeenCalledTimes(1);
        expect(reader.close).toHaveBeenCalledTimes(1);
    });

    it('reports reader close timeout without throwing from cleanup', async () => {
        const reader = { close: jest.fn(() => new Promise<void>(() => undefined)) } as unknown as DatabaseDataReader;
        const result = await cancelCommandAndCloseReader(undefined, reader, { timeoutMs: 1 });

        expect(result.timedOut).toBe(true);
        expect(result.closeError).toBeInstanceOf(Error);
    });

    it('preserves the typed partial-export contract', () => {
        const error = new ExportCancelledError('/tmp/result.json', 42);

        expect(error.code).toBe('EXPORT_CANCELLED');
        expect(error.filePath).toBe('/tmp/result.json');
        expect(error.rowsWritten).toBe(42);
        expect(error.partial).toBe(true);
        expect(isCancellationError(error)).toBe(true);
    });

    it('does not classify arbitrary SQL error text as cancellation', () => {
        expect(isCancellationError(new Error('column "cancel" does not exist'))).toBe(false);
        expect(isCancellationError(new Error('column "cancelled" does not exist'))).toBe(false);
    });

    it.each([
        'Variable input cancelled by user',
        'cancelled: user request',
        'The operation was aborted.',
    ])('recognizes cancellation message: %s', message => {
        expect(isCancellationError(new Error(message))).toBe(true);
    });

    it('recognizes a DOM AbortError by name', () => {
        expect(isCancellationError({ name: 'AbortError', message: 'The operation was aborted.' })).toBe(true);
        expect(isCancellationError({ name: 'AbortError' })).toBe(true);
    });
});
