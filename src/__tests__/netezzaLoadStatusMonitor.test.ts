import {
    readNetezzaLoadStatus,
    resolveNetezzaLoadStatusDatabase,
    startNetezzaLoadStatusMonitor,
} from '../import/netezzaLoadStatusMonitor';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ImportLoadStatus } from '@justybase/contracts';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

const createConnection = createConnectedDatabaseConnectionFromDetails as jest.Mock;

function fakeConnection(rows: Array<Record<string, unknown>>, executeReader?: jest.Mock) {
    const names = [
        'PLANID',
        'TABLENAME',
        'SCHEMANAME',
        'DATABASENAME',
        'USERNAME',
        'ROWSINSERTED',
        'ROWSREJECTED',
        'BYTESPROCESSED',
        'BYTESDOWNLOADED',
    ];
    let index = -1;
    const reader = {
        fieldCount: names.length,
        getName: (i: number) => names[i],
        getValue: (i: number) => rows[index]?.[names[i]] ?? null,
        read: async () => {
            index++;
            return index < rows.length;
        },
        close: jest.fn(async () => undefined),
    };
    const command = {
        commandTimeout: 0,
        executeReader: executeReader ?? jest.fn(async () => reader),
    };
    const connection = {
        createCommand: jest.fn(() => command),
        close: jest.fn(async () => undefined),
    };
    return { connection, command, reader };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const started = Date.now();
    while (!predicate() && Date.now() - started < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

describe('NetezzaLoadStatusMonitor', () => {
    it('resolves the database used by _V_LOAD_STATUS from the target table', () => {
        expect(resolveNetezzaLoadStatusDatabase('JUST_DATA..TARGET', 'OTHER')).toBe('JUST_DATA');
        expect(resolveNetezzaLoadStatusDatabase('JUST_DATA.ADMIN.TARGET', 'OTHER')).toBe('JUST_DATA');
        expect(resolveNetezzaLoadStatusDatabase('ADMIN.TARGET', 'OTHER')).toBe('OTHER');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('polls _V_LOAD_STATUS on a dedicated connection and reports the matching plan', async () => {
        const { connection } = fakeConnection([
            { PLANID: 23, TABLENAME: 'OTHER', USERNAME: 'ADMIN', ROWSINSERTED: 1 },
            { PLANID: 24, TABLENAME: 'TARGET', USERNAME: 'ADMIN', ROWSINSERTED: 100, ROWSREJECTED: 0, BYTESDOWNLOADED: 1000 },
        ]);
        createConnection.mockResolvedValue(connection);
        const statuses: ImportLoadStatus[] = [];
        const monitor = startNetezzaLoadStatusMonitor({
            connectionDetails: { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            targetTable: 'JUST_DATA.ADMIN.TARGET',
            databaseName: 'JUST_DATA',
            intervalMs: 10,
            onStatus: status => statuses.push(status),
        });

        await waitFor(() => statuses.length > 0);
        monitor.stop();

        expect(connection.createCommand).toHaveBeenCalledWith(
            expect.stringMatching(/SELECT \* FROM .*JUST_DATA.*\.\._V_LOAD_STATUS/),
        );
        expect(statuses[0]).toEqual(expect.objectContaining({
            planId: 24,
            tableName: 'TARGET',
            rowsInserted: 100,
            bytesDownloaded: 1000,
        }));
        expect(connection.close).toHaveBeenCalled();
    });

    it('reads the newest matching plan for the database and user', async () => {
        const { connection } = fakeConnection([
            { PLANID: 10, TABLENAME: 'TARGET', DATABASENAME: 'JUST_DATA', USERNAME: 'ADMIN', ROWSINSERTED: 4 },
            { PLANID: 12, TABLENAME: 'TARGET', DATABASENAME: 'JUST_DATA', USERNAME: 'ADMIN', ROWSINSERTED: 8, ROWSREJECTED: 1, BYTESDOWNLOADED: 2048 },
            { PLANID: 11, TABLENAME: 'TARGET', DATABASENAME: 'OTHER', USERNAME: 'ADMIN', ROWSINSERTED: 6 },
        ]);

        await expect(readNetezzaLoadStatus(connection as never, {
            targetTable: 'JUST_DATA.ADMIN.TARGET',
            databaseName: 'JUST_DATA',
            user: 'ADMIN',
        })).resolves.toEqual(expect.objectContaining({
            planId: 12,
            tableName: 'TARGET',
            rowsInserted: 8,
            rowsRejected: 1,
            bytesDownloaded: 2048,
        }));

        expect((connection.createCommand as jest.Mock).mock.calls[0][0]).toMatch(
            /SELECT \* FROM .*JUST_DATA.*\.\._V_LOAD_STATUS/,
        );
    });

    it('falls back to database plans when the user has no matching plan', async () => {
        const { connection } = fakeConnection([
            { PLANID: 20, TABLENAME: 'TARGET', DATABASENAME: 'JUST_DATA', USERNAME: 'OTHER', ROWSINSERTED: 3 },
        ]);

        await expect(readNetezzaLoadStatus(connection as never, {
            targetTable: 'ADMIN.TARGET',
            databaseName: 'JUST_DATA',
            user: 'ADMIN',
        })).resolves.toEqual(expect.objectContaining({ planId: 20, rowsInserted: 3 }));
    });

    it('returns undefined when the table or database has no load plan', async () => {
        const missingTable = fakeConnection([
            { PLANID: 30, TABLENAME: 'OTHER', DATABASENAME: 'JUST_DATA', USERNAME: 'ADMIN' },
        ]);
        await expect(readNetezzaLoadStatus(missingTable.connection as never, {
            targetTable: 'ADMIN.TARGET',
            databaseName: 'JUST_DATA',
        })).resolves.toBeUndefined();

        const missingDatabase = fakeConnection([
            { PLANID: 31, TABLENAME: 'TARGET', DATABASENAME: 'OTHER', USERNAME: 'ADMIN' },
        ]);
        await expect(readNetezzaLoadStatus(missingDatabase.connection as never, {
            targetTable: 'ADMIN.TARGET',
            databaseName: 'JUST_DATA',
        })).resolves.toBeUndefined();
    });

    it('queries the unqualified view when no database is configured', async () => {
        const { connection } = fakeConnection([
            { PLANID: 40, TABLENAME: 'TARGET', USERNAME: 'ADMIN', ROWSINSERTED: 2 },
        ]);

        await expect(readNetezzaLoadStatus(connection as never, {
            targetTable: 'ADMIN.TARGET',
        })).resolves.toEqual(expect.objectContaining({ planId: 40 }));

        expect((connection.createCommand as jest.Mock).mock.calls[0][0]).toBe('SELECT * FROM _V_LOAD_STATUS');
    });

    it('stays silent when the view is unavailable and closes its connection', async () => {
        const { connection } = fakeConnection([], jest.fn(async () => {
            throw new Error('permission denied');
        }));
        createConnection.mockResolvedValue(connection);
        const statuses: ImportLoadStatus[] = [];
        const monitor = startNetezzaLoadStatusMonitor({
            connectionDetails: { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            targetTable: 'ADMIN.TARGET',
            databaseName: 'JUST_DATA',
            intervalMs: 10,
            onStatus: status => statuses.push(status),
        });

        await waitFor(() => (connection.close as jest.Mock).mock.calls.length > 0);
        monitor.stop();

        expect(statuses).toHaveLength(0);
        expect(connection.close).toHaveBeenCalled();
    });
});
