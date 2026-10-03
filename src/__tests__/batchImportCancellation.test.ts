/**
 * Cancellation contract for the shared batch import path.
 *
 * The webview/host boundary aborts an in-flight import by flipping the
 * `isCancelled` predicate; the batch writer must stop before the next insert
 * and report a cancelled result rather than finishing the transfer.
 */

import type { BatchImportDialectConfig } from '../import/batchImportSupport';
import { executeBatchImport } from '../import/batchImportSupport';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

describe('executeBatchImport cancellation', () => {
    const connection = {
        createCommand: jest.fn(() => ({ commandTimeout: 0, execute: jest.fn().mockResolvedValue(undefined) })),
        close: jest.fn().mockResolvedValue(undefined),
    };

    const config = {
        kind: 'postgresql',
        label: 'PostgreSQL',
        insertBatchSize: 2,
        parseTargetTable: (targetTable: string) => ({ table: targetTable, qualifiedName: targetTable, displayName: targetTable }),
        toSqlLiteral: (value: string | null) => (value === null ? 'NULL' : `'${value}'`),
        mapImportType: (typeName: string) => typeName,
    } as unknown as BatchImportDialectConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
    });

    it('stops before opening a connection when already cancelled', async () => {
        const result = await executeBatchImport(config, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            appendToExistingTable: true,
            rows: [['1'], ['2'], ['3']],
            totalRows: 3,
            decimalDelimiter: '.',
            format: 'CSV',
            isCancelled: () => true,
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/cancelled/i);
        expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();
        expect(connection.createCommand).not.toHaveBeenCalled();
        // Nothing was opened, so there is no connection to close.
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('closes the connection when cancelled after connecting but before the first batch', async () => {
        let checks = 0;
        const result = await executeBatchImport(config, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            appendToExistingTable: true,
            rows: [['1'], ['2'], ['3']],
            totalRows: 3,
            decimalDelimiter: '.',
            format: 'CSV',
            // Allow the pre-connect checks (prepare + connect) to pass, then
            // cancel at the batch boundary so the connection is released.
            isCancelled: () => {
                checks += 1;
                return checks > 3;
            },
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/cancelled/i);
        expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalled();
        expect(connection.createCommand).not.toHaveBeenCalled();
        expect(connection.close).toHaveBeenCalled();
    });

    it('completes normally when not cancelled', async () => {
        const result = await executeBatchImport(config, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            appendToExistingTable: true,
            rows: [['1'], ['2'], ['3']],
            totalRows: 3,
            decimalDelimiter: '.',
            format: 'CSV',
            isCancelled: () => false,
        });

        expect(result.success).toBe(true);
        expect(connection.createCommand).toHaveBeenCalled();
        expect(connection.close).toHaveBeenCalled();
    });
});
