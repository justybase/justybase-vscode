import { Db2Connection } from '../../../../extensions/db2/src/db2Connection';

type MockDb2Result = {
    fetch: jest.Mock<Promise<unknown>, []>;
    fetchAllSync: jest.Mock;
    getColumnMetadataSync: jest.Mock;
    getColumnNamesSync: jest.Mock;
    close: jest.Mock<Promise<void>, []>;
    closeSync: jest.Mock;
};

type MockDb2Database = {
    query: jest.Mock<Promise<unknown>, [string]>;
    queryResult: jest.Mock<Promise<[MockDb2Result | null, unknown[]]>, [string]>;
    querySync: jest.Mock;
    queryResultSync: jest.Mock;
    close: jest.Mock;
    closeSync: jest.Mock;
};

function createConnectionWithDatabase(database: MockDb2Database): Db2Connection {
    const connection = new Db2Connection({
        host: 'db2.example.local',
        port: 50000,
        database: 'TESTDB',
        user: 'db2inst1',
        password: 'secret'
    });

    const internal = connection as unknown as { _database: MockDb2Database };
    internal._database = database;
    return connection;
}

function createResult(rows: unknown[]): MockDb2Result {
    const pendingRows = [...rows];
    return {
        fetch: jest.fn(async () => pendingRows.shift() ?? null),
        fetchAllSync: jest.fn(() => {
            throw new Error('fetchAllSync should not be called');
        }),
        getColumnMetadataSync: jest.fn(() => [
            { SQL_DESC_NAME: 'ID', SQL_DESC_TYPE_NAME: 'INTEGER' },
            { SQL_DESC_NAME: 'NAME', SQL_DESC_TYPE_NAME: 'VARCHAR' }
        ]),
        getColumnNamesSync: jest.fn(() => ['ID', 'NAME']),
        close: jest.fn(async () => undefined),
        closeSync: jest.fn()
    };
}

function createDatabase(result: MockDb2Result | null): MockDb2Database {
    return {
        query: jest.fn(async (_sql: string) => undefined),
        queryResult: jest.fn(async (_sql: string) => [result, []] as [MockDb2Result | null, unknown[]]),
        querySync: jest.fn(() => {
            throw new Error('querySync should not be called');
        }),
        queryResultSync: jest.fn(() => {
            throw new Error('queryResultSync should not be called');
        }),
        close: jest.fn(),
        closeSync: jest.fn()
    };
}

describe('Db2Connection async streaming', () => {
    it('streams rows through async fetch without sync result APIs', async () => {
        const result = createResult([{ ID: 1, NAME: 'Alice' }, [2, 'Bob']]);
        const database = createDatabase(result);
        const connection = createConnectionWithDatabase(database);

        const reader = await connection.createCommand('SELECT ID, NAME FROM EMP').executeReader();

        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);
        expect(reader.getValue(1)).toBe('Alice');

        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(2);
        expect(reader.getValue(1)).toBe('Bob');

        await expect(reader.read()).resolves.toBe(false);
        expect(database.queryResult).toHaveBeenCalledWith('SELECT ID, NAME FROM EMP');
        expect(database.queryResultSync).not.toHaveBeenCalled();
        expect(result.fetchAllSync).not.toHaveBeenCalled();
        expect(result.close).toHaveBeenCalledTimes(1);
    });

    it('allows the event loop to run while a DB2 fetch is pending', async () => {
        let resolveFetch: (row: unknown) => void = () => undefined;
        const result = createResult([]);
        result.fetch.mockImplementationOnce(async () => new Promise(resolve => {
            resolveFetch = resolve;
        }));
        const connection = createConnectionWithDatabase(createDatabase(result));

        const reader = await connection.createCommand('SELECT ID, NAME FROM EMP').executeReader();
        const readPromise = reader.read();

        let immediateRan = false;
        await new Promise<void>(resolve => {
            setImmediate(() => {
                immediateRan = true;
                resolve();
            });
        });

        expect(immediateRan).toBe(true);
        resolveFetch({ ID: 1, NAME: 'Alice' });
        await expect(readPromise).resolves.toBe(true);
    });

    it('closes the active result handle when cancelled during a pending fetch', async () => {
        let resolveFetch: (row: unknown) => void = () => undefined;
        const result = createResult([]);
        result.fetch.mockImplementationOnce(async () => new Promise(resolve => {
            resolveFetch = resolve;
        }));
        const database = createDatabase(result);
        const connection = createConnectionWithDatabase(database);
        const command = connection.createCommand('SELECT ID, NAME FROM EMP');

        const reader = await command.executeReader();
        const readPromise = reader.read();

        await command.cancel();
        expect(result.close).toHaveBeenCalledTimes(1);

        resolveFetch({ ID: 1, NAME: 'Alice' });
        await expect(readPromise).resolves.toBe(false);
        await expect(reader.read()).resolves.toBe(false);
    });

    it('closes result handle when cancelled while queryResult is still pending', async () => {
        let resolveQueryResult: (value: [MockDb2Result | null, unknown[]]) => void = () => undefined;
        const result = createResult([{ ID: 1, NAME: 'Alice' }]);
        const database = createDatabase(result);
        database.queryResult.mockImplementationOnce(async (_sql: string) => new Promise(resolve => {
            resolveQueryResult = resolve;
        }));
        const connection = createConnectionWithDatabase(database);
        const command = connection.createCommand('SELECT ID, NAME FROM EMP');

        const executePromise = command.executeReader();

        await command.cancel();
        expect(result.close).not.toHaveBeenCalled();

        resolveQueryResult([result, []]);

        await expect(executePromise).rejects.toThrow('Query cancelled.');
        expect(result.close).toHaveBeenCalledTimes(1);
        expect(result.fetch).not.toHaveBeenCalled();
    });

    it('falls back to async query rows when queryResult returns no handle', async () => {
        const database = createDatabase(null);
        database.query.mockResolvedValueOnce([{ TEST_VALUE: 1 }]);
        const connection = createConnectionWithDatabase(database);

        const reader = await connection.createCommand('SELECT 1 AS TEST_VALUE FROM SYSIBM.SYSDUMMY1').executeReader();

        await expect(reader.read()).resolves.toBe(true);
        expect(reader.fieldCount).toBe(1);
        expect(reader.getName(0)).toBe('TEST_VALUE');
        expect(reader.getValue(0)).toBe(1);
        await expect(reader.read()).resolves.toBe(false);
        expect(database.querySync).not.toHaveBeenCalled();
    });

    it('surfaces DB2 SQL error payloads from async fallback execution', async () => {
        const database = createDatabase(null);
        database.query.mockResolvedValueOnce(
            '[node-ibm_db] Error in ODBCConnection::QuerySync while executing query.\t-104\t' +
            'SQL0104N  An unexpected token "," was found. SQLSTATE=42601'
        );
        const connection = createConnectionWithDatabase(database);

        await expect(connection.createCommand('SELECT 1,,2 FROM SYSIBM.SYSDUMMY1').executeReader())
            .rejects.toThrow('SQL0104N');
    });
});
