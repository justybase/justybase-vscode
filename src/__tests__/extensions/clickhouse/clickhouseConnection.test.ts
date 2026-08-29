import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ClickHouseConnection } from '../../../../extensions/clickhouse/src/clickhouseConnection';

jest.mock('@clickhouse/client', () => ({
    createClient: jest.fn(),
}), { virtual: true });

const mockedCreateClient = (jest.requireMock('@clickhouse/client') as {
    createClient: jest.Mock;
}).createClient;

describe('ClickHouseConnection', () => {
    const command = jest.fn(async (_options?: unknown) => ({ summary: { written_rows: '3' } }));
    const query = jest.fn();
    const close = jest.fn(async () => undefined);

    beforeEach(() => {
        jest.clearAllMocks();
        mockedCreateClient.mockReturnValue({
            ping: jest.fn(async () => ({ success: true })),
            command,
            query,
            close,
        });
    });

    it('routes non-row executeReader statements through the command API', async () => {
        const connection = new ClickHouseConnection({
            host: 'localhost',
            database: 'default',
            user: 'default',
        });
        await connection.connect();

        const databaseCommand = connection.createCommand('/* editor */ CREATE TABLE events (id UInt64);');
        const reader = await databaseCommand.executeReader();

        expect(command).toHaveBeenCalledWith(expect.objectContaining({
            query: '/* editor */ CREATE TABLE events (id UInt64)',
        }));
        expect(query).not.toHaveBeenCalled();
        expect(databaseCommand._recordsAffected).toBe(3);
        expect(reader.fieldCount).toBe(0);
        expect(await reader.read()).toBe(false);

        await reader.close();
        await connection.close();
    });
});
