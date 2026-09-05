import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
    buildClickHouseClientOptions,
    ClickHouseConnection,
    type ClickHouseClientFactory,
} from '../../../../extensions/clickhouse/src/clickhouseConnection';

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
        const client = mockedCreateClient() as ReturnType<ClickHouseClientFactory>;
        const connection = new ClickHouseConnection({
            host: 'localhost',
            database: 'default',
            user: 'default',
        }, () => client);
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

    it('uses the configured TLS server name for HTTPS connections through a local tunnel', () => {
        const clientConfig = buildClickHouseClientOptions({
            host: '127.0.0.1',
            port: 18443,
            database: 'default',
            user: 'default',
            options: {
                protocol: 'https',
                tlsMode: 'verify-full',
                tlsServerName: 'clickhouse.private.example',
            },
        }, 'default');

        expect(clientConfig.url?.toString()).toBe('https://127.0.0.1:18443/');
        expect((clientConfig.http_agent as { options?: { rejectUnauthorized?: boolean; servername?: string } } | undefined)?.options).toEqual(expect.objectContaining({
            rejectUnauthorized: true,
            servername: 'clickhouse.private.example',
        }));
    });
});
