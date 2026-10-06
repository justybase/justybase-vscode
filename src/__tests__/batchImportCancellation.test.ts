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

    it('drops a newly created target table when the import fails', async () => {
        const executedSql: string[] = [];
        const failingConnection = {
            createCommand: jest.fn((sql: string) => {
                executedSql.push(sql);
                return {
                    commandTimeout: 0,
                    execute: sql.startsWith('INSERT')
                        ? jest.fn().mockRejectedValue(new Error('insert failed'))
                        : jest.fn().mockResolvedValue(undefined),
                };
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(failingConnection);
        const configWithCleanup = {
            ...config,
            cleanupCreatedTargetOnFailure: true,
            buildCreateTableSql: () => 'CREATE TABLE "orders" (ID BIGINT)',
            buildDropTableSql: (target: { qualifiedName: string }) => `DROP TABLE ${target.qualifiedName}`,
        } as unknown as BatchImportDialectConfig;

        const result = await executeBatchImport(configWithCleanup, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            rows: [['1']],
            totalRows: 1,
            decimalDelimiter: '.',
            format: 'CSV',
        });

        expect(result.success).toBe(false);
        expect(executedSql).toContain('CREATE TABLE "orders" (ID BIGINT)');
        expect(executedSql).toContain('DROP TABLE public.orders');
    });

    it('keeps the created target table when no cleanup is configured', async () => {
        const executedSql: string[] = [];
        const failingConnection = {
            createCommand: jest.fn((sql: string) => {
                executedSql.push(sql);
                return {
                    commandTimeout: 0,
                    execute: sql.startsWith('INSERT')
                        ? jest.fn().mockRejectedValue(new Error('insert failed'))
                        : jest.fn().mockResolvedValue(undefined),
                };
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(failingConnection);
        const configWithoutCleanup = {
            ...config,
            buildCreateTableSql: () => 'CREATE TABLE "orders" (ID BIGINT)',
        } as unknown as BatchImportDialectConfig;

        const result = await executeBatchImport(configWithoutCleanup, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            rows: [['1']],
            totalRows: 1,
            decimalDelimiter: '.',
            format: 'CSV',
        });

        expect(result.success).toBe(false);
        expect(executedSql.some(sql => sql.startsWith('DROP TABLE'))).toBe(false);
    });

    it('applies the requested statement timeout to batch statements', async () => {
        const timeouts: number[] = [];
        const recordingConnection = {
            createCommand: jest.fn(() => {
                const command = {
                    commandTimeout: 0,
                    execute: jest.fn(async () => {
                        timeouts.push(command.commandTimeout);
                    }),
                };
                return command;
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(recordingConnection);

        const result = await executeBatchImport(config, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            appendToExistingTable: true,
            rows: [['1'], ['2'], ['3']],
            totalRows: 3,
            decimalDelimiter: '.',
            format: 'CSV',
            timeoutSeconds: 42,
        });

        expect(result.success).toBe(true);
        expect(timeouts.length).toBeGreaterThan(0);
        expect(timeouts.every((timeout) => timeout === 42)).toBe(true);
    });

    it('rolls back transactions, drops the target and surfaces source warnings on failure', async () => {
        const executedSql: string[] = [];
        const failingConnection = {
            createCommand: jest.fn((sql: string) => {
                executedSql.push(sql);
                return {
                    commandTimeout: 0,
                    execute: sql.includes('INSERT')
                        ? jest.fn().mockRejectedValue(new Error('insert failed'))
                        : jest.fn().mockResolvedValue(undefined),
                };
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(failingConnection);
        const transactionalConfig = {
            ...config,
            beginTransactionSql: 'BEGIN',
            commitTransactionSql: 'COMMIT',
            rollbackTransactionSql: 'ROLLBACK',
            cleanupCreatedTargetOnFailure: true,
            buildCreateTableSql: () => 'CREATE TABLE "orders" (ID BIGINT)',
            buildDropTableSql: (target: { qualifiedName: string }) => `DROP TABLE ${target.qualifiedName}`,
        } as unknown as BatchImportDialectConfig;

        const result = await executeBatchImport(transactionalConfig, {
            targetTable: 'public.orders',
            connectionDetails: { host: 'db', dbType: 'postgresql' } as never,
            columns: [{ sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }],
            rows: [['1']],
            totalRows: 1,
            decimalDelimiter: '.',
            format: 'CSV',
            sourceWarnings: ['1 source row had a different column count.'],
        });

        expect(result.success).toBe(false);
        expect(executedSql).toContain('ROLLBACK');
        expect(executedSql).toContain('DROP TABLE public.orders');
        expect(result.details?.warnings).toContain('1 source row had a different column count.');
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
