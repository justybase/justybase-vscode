jest.mock('../../core/mcpConnectionFactory', () => ({
    createConnectedNetezzaConnectionFromDetails: jest.fn(),
}));

import { createConnectedNetezzaConnectionFromDetails } from '../../core/mcpConnectionFactory';
import {
    clampMaxRows,
    clampTimeout,
    executeStatement,
} from '../../core/assistant/executionService';

const createConnected = createConnectedNetezzaConnectionFromDetails as jest.MockedFunction<
    typeof createConnectedNetezzaConnectionFromDetails
>;

function createMockConnection(): {
    connection: {
        on: jest.Mock;
        removeListener: jest.Mock;
        close: jest.Mock;
        createCommand: jest.Mock;
    };
    command: {
        commandTimeout: number;
        executeReader: jest.Mock;
        executeNonQuery: jest.Mock;
        cancel: jest.Mock;
        notices: string[];
    };
    reader: {
        fieldCount: number;
        getName: jest.Mock;
        read: jest.Mock;
        getValues: jest.Mock;
        close: jest.Mock;
    };
} {
    const reader = {
        fieldCount: 1,
        getName: jest.fn(() => 'X'),
        read: jest.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false),
        getValues: jest.fn(() => [1]),
        close: jest.fn().mockResolvedValue(undefined),
    };
    const command = {
        commandTimeout: 0,
        executeReader: jest.fn().mockResolvedValue(reader),
        executeNonQuery: jest.fn().mockResolvedValue(3),
        cancel: jest.fn().mockResolvedValue(undefined),
        notices: [],
    };
    const connection = {
        on: jest.fn(),
        removeListener: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn(() => command),
    };
    return { connection, command, reader };
}

describe('assistant execution service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('clamps row and timeout options', () => {
        expect(clampMaxRows(undefined)).toBe(500);
        expect(clampMaxRows(0)).toBe(1);
        expect(clampMaxRows(100_000)).toBe(5_000);
        expect(clampTimeout(undefined)).toBe(60_000);
        expect(clampTimeout(10)).toBe(1_000);
        expect(clampTimeout(1_000_000)).toBe(300_000);
    });

    it('passes the timeout to the driver in seconds', async () => {
        const { connection, command } = createMockConnection();
        createConnected.mockResolvedValue(connection as never);

        await executeStatement(
            { host: 'h', database: 'D', user: 'U' },
            'SELECT 1',
            { timeoutMs: 60_000 },
        );

        expect(command.commandTimeout).toBe(60);
        expect(connection.close).toHaveBeenCalled();
    });

    it('returns capped rows and marks truncation', async () => {
        const { connection, reader } = createMockConnection();
        reader.read
            .mockReset()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        createConnected.mockResolvedValue(connection as never);

        const result = await executeStatement(
            { host: 'h', database: 'D', user: 'U' },
            'SELECT 1',
            { maxRows: 1 },
        );

        expect(result.kind).toBe('read');
        expect(result.rows).toEqual([[1]]);
        expect(result.truncated).toBe(true);
    });

    it('uses the non-query path for writes', async () => {
        const { connection, command } = createMockConnection();
        createConnected.mockResolvedValue(connection as never);

        const result = await executeStatement(
            { host: 'h', database: 'D', user: 'U' },
            'DELETE FROM ADMIN.ORDERS',
        );

        expect(result.kind).toBe('write');
        expect(result.affectedRows).toBe(3);
        expect(command.executeNonQuery).toHaveBeenCalled();
    });
});
