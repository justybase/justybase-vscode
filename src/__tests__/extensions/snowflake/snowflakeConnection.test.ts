const executeMock = jest.fn();
const connectMock = jest.fn();
const destroyMock = jest.fn();
const createConnectionMock = jest.fn();

jest.mock('node:module', () => {
    const actual = jest.requireActual('node:module');
    return {
        ...actual,
        createRequire: () => (moduleName: string) => {
            if (moduleName === 'snowflake-sdk') {
                return {
                    createConnection: createConnectionMock,
                };
            }
            throw new Error(`Unexpected module requested in test: ${moduleName}`);
        },
    };
});

import { SnowflakeConnection } from '../../../../extensions/snowflake/src/snowflakeConnection';

describe('SnowflakeConnection', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        executeMock.mockImplementation(({ complete }: { complete?: (error: Error | undefined) => void }) => {
            const statement = {
                cancel: jest.fn(),
                getColumns: () => undefined,
                getNumUpdatedRows: () => undefined,
            };
            complete?.(undefined);
            return statement;
        });

        connectMock.mockImplementation((callback?: (error?: Error) => void) => {
            callback?.(undefined);
            return {
                connect: connectMock,
                execute: executeMock,
                destroy: destroyMock,
            };
        });

        destroyMock.mockImplementation((callback?: (error?: Error) => void) => {
            callback?.(undefined);
        });

        createConnectionMock.mockReturnValue({
            connect: connectMock,
            execute: executeMock,
            destroy: destroyMock,
        });
    });

    it('initializes the Snowflake session with explicit current database and schema', async () => {
        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'analytics',
            user: 'tester',
            password: 'secret',
            options: {
                role: 'analyst',
                warehouse: 'transforming_wh',
                schema: 'reporting',
            },
        });

        await connection.connect();

        // Unquoted Snowflake identifiers are normalized to uppercase so later quoted USE statements
        // still resolve the default database/schema/role/warehouse correctly.
        expect(createConnectionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                database: 'ANALYTICS',
                schema: 'REPORTING',
                role: 'ANALYST',
                warehouse: 'TRANSFORMING_WH',
                rowMode: 'object',
            }),
        );
        // Role and warehouse are passed to snowflake-sdk via connection options,
        // not executed as USE statements during connect (to avoid extra round-trips).
        // The SDK handles role/warehouse initialization.
        expect(executeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                sqlText: 'USE DATABASE "ANALYTICS"',
            }),
        );
        expect(executeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                sqlText: 'USE SCHEMA "REPORTING"',
            }),
        );
        expect(connection.getCurrentDatabase()).toBe('ANALYTICS');
        expect(connection.getCurrentSchema()).toBe('REPORTING');
        expect(connection.getCurrentWarehouse()).toBe('TRANSFORMING_WH');
        expect(connection.getCurrentRole()).toBe('ANALYST');
    });

    it('connects successfully when configured database does not exist', async () => {
        executeMock.mockImplementation(
            ({ sqlText, complete }: { sqlText: string; complete?: (error: Error | undefined) => void }) => {
                if (sqlText.startsWith('USE DATABASE')) {
                    complete?.(
                        new Error('SQL compilation error: Object does not exist, or operation cannot be performed.'),
                    );
                } else {
                    complete?.(undefined);
                }
                return { cancel: jest.fn(), getColumns: () => undefined, getNumUpdatedRows: () => undefined };
            },
        );

        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'nonexistent_db',
            user: 'tester',
            password: 'secret',
        });

        await connection.connect();
        expect(connection._connected).toBe(true);
        // getCurrentDatabase() falls back to the normalized config value so metadata queries can
        // still qualify references consistently even when USE DATABASE fails.
        expect(connection.getCurrentDatabase()).toBe('NONEXISTENT_DB');
    });

    it('connects successfully when configured schema does not exist', async () => {
        executeMock.mockImplementation(
            ({ sqlText, complete }: { sqlText: string; complete?: (error: Error | undefined) => void }) => {
                if (sqlText.startsWith('USE SCHEMA')) {
                    complete?.(new Error('SQL compilation error: Object does not exist.'));
                } else {
                    complete?.(undefined);
                }
                return { cancel: jest.fn(), getColumns: () => undefined, getNumUpdatedRows: () => undefined };
            },
        );

        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'analytics',
            user: 'tester',
            password: 'secret',
            options: { schema: 'nonexistent_schema' },
        });

        await connection.connect();
        expect(connection._connected).toBe(true);
        expect(connection.getCurrentDatabase()).toBe('ANALYTICS');
        expect(connection.getCurrentSchema()).toBe('PUBLIC');
    });

    it('preserves explicitly quoted case-sensitive identifiers', async () => {
        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: '"analyticsLower"',
            user: 'tester',
            password: 'secret',
            options: {
                schema: '"reportingLower"',
                role: '"analystLower"',
                warehouse: '"transformingLower"',
            },
        });

        await connection.connect();

        expect(createConnectionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                database: 'analyticsLower',
                schema: 'reportingLower',
                role: 'analystLower',
                warehouse: 'transformingLower',
            }),
        );
        expect(executeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                sqlText: 'USE DATABASE "analyticsLower"',
            }),
        );
        expect(executeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                sqlText: 'USE SCHEMA "reportingLower"',
            }),
        );
        expect(connection.getCurrentDatabase()).toBe('analyticsLower');
        expect(connection.getCurrentSchema()).toBe('reportingLower');
        expect(connection.getCurrentWarehouse()).toBe('transformingLower');
        expect(connection.getCurrentRole()).toBe('analystLower');
    });

    it('translates SET CATALOG into a Snowflake USE DATABASE statement', async () => {
        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'analytics',
            user: 'tester',
            password: 'secret',
        });

        await connection.connect();
        executeMock.mockClear();

        const command = connection.createCommand('SET CATALOG reporting');
        await command.execute();

        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(executeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sqlText: 'USE DATABASE "REPORTING"',
            }),
        );
        expect(connection.getCurrentDatabase()).toBe('REPORTING');
        expect(connection.getCurrentSchema()).toBe('PUBLIC');
    });

    it('resolves env-backed OAuth and key-pair options', async () => {
        process.env.SNOWFLAKE_TEST_TOKEN = 'oauth-token';
        process.env.SNOWFLAKE_TEST_KEY_PATH = '/tmp/test-key.p8';

        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'analytics',
            user: 'tester',
            options: {
                authMode: 'OAUTH',
                oauthToken: 'env:SNOWFLAKE_TEST_TOKEN',
                privateKeyPath: 'env:SNOWFLAKE_TEST_KEY_PATH',
            },
        });

        await connection.connect();

        expect(createConnectionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                authenticator: 'OAUTH',
                token: 'oauth-token',
                rowMode: 'object',
            }),
        );

        delete process.env.SNOWFLAKE_TEST_TOKEN;
        delete process.env.SNOWFLAKE_TEST_KEY_PATH;
    });

    it('tracks warehouse and role changes executed after connect', async () => {
        const connection = new SnowflakeConnection({
            host: 'test-account',
            database: 'analytics',
            user: 'tester',
            password: 'secret',
        });

        await connection.connect();
        executeMock.mockClear();

        await connection.createCommand('USE WAREHOUSE "etl_wh"').execute();
        await connection.createCommand('USE ROLE loader').execute();

        expect(connection.getCurrentWarehouse()).toBe('ETL_WH');
        expect(connection.getCurrentRole()).toBe('LOADER');
        expect(executeMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                sqlText: 'USE WAREHOUSE "ETL_WH"',
            }),
        );
        expect(executeMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                sqlText: 'USE ROLE "LOADER"',
            }),
        );
    });
});
