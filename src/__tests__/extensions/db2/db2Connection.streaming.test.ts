import { EventEmitter } from 'node:events';
import type {
    DatabaseCommand,
    DatabaseConnectionConfig,
    DatabaseDataReader
} from '../../../../packages/contracts/src/database/connection';
import { Db2Connection } from '../../../../extensions/db2/src/db2Connection';

type DriverFactory = NonNullable<ConstructorParameters<typeof Db2Connection>[1]>;
type DriverConnection = ReturnType<DriverFactory> & Pick<EventEmitter, 'emit'>;

const connectionConfig: DatabaseConnectionConfig = {
    host: 'db2.example.local',
    port: 50000,
    database: 'TESTDB',
    user: 'db2inst1',
    password: 'sensitive-password',
    options: {
        currentSchema: 'APP',
        connectTimeout: 30,
        security: 'SSL',
        sslServerCertificate: '/tmp/db2-ca.pem',
        clientCodepage: '819'
    }
};

function createReader(values: readonly unknown[]): DatabaseDataReader {
    let rowIndex = -1;
    const names = ['BIG_VALUE', 'DECIMAL_VALUE'];
    const row = [...values];

    return {
        fieldCount: names.length,
        async read(): Promise<boolean> {
            rowIndex += 1;
            return rowIndex === 0;
        },
        async nextResult(): Promise<boolean> {
            return false;
        },
        async close(): Promise<void> {},
        getName(index: number): string {
            return names[index] ?? '';
        },
        getTypeName(index: number): string {
            return index === 0 ? 'BIGINT' : 'DECIMAL';
        },
        getValue(index: number): unknown {
            return rowIndex === 0 ? row[index] : undefined;
        }
    };
}

function createDriverHarness(options: { connectError?: Error } = {}) {
    const events = new EventEmitter();
    const reader = createReader([9223372036854775807n, '1234567890123.123456789012345678']);
    const command: DatabaseCommand = {
        commandTimeout: 0,
        _recordsAffected: -1,
        executeReader: jest.fn(async () => reader),
        cancel: jest.fn(async () => undefined),
        execute: jest.fn(async () => undefined)
    };

    const driver = new EventEmitter() as unknown as DriverConnection;
    driver._connected = false;
    driver.connect = jest.fn(async () => {
        if (options.connectError) {
            throw options.connectError;
        }
        driver._connected = true;
    });
    driver.close = jest.fn(async () => {
        driver._connected = false;
        driver.emit('close');
    });
    driver.createCommand = jest.fn((_sql: string) => command as ReturnType<DriverConnection['createCommand']>);

    const factory = jest.fn((_config: DatabaseConnectionConfig) => driver);
    return { command, driver, events, factory, reader };
}

describe('Db2Connection driver adapter', () => {
    it('passes connection options to the driver and delegates lifecycle state', async () => {
        const harness = createDriverHarness();
        const connection = new Db2Connection(connectionConfig, harness.factory);

        expect(harness.factory).toHaveBeenCalledWith(connectionConfig);
        expect(connection._connected).toBe(false);

        await connection.connect();
        expect(harness.driver.connect).toHaveBeenCalledTimes(1);
        expect(connection._connected).toBe(true);

        await connection.close();
        expect(harness.driver.close).toHaveBeenCalledTimes(1);
        expect(connection._connected).toBe(false);
    });

    it('delegates commands and preserves exact BIGINT and DECIMAL values', async () => {
        const harness = createDriverHarness();
        const connection = new Db2Connection(connectionConfig, harness.factory);
        const command = connection.createCommand('SELECT BIG_VALUE, DECIMAL_VALUE FROM APP.T');
        const reader = await command.executeReader();

        expect(harness.driver.createCommand).toHaveBeenCalledWith('SELECT BIG_VALUE, DECIMAL_VALUE FROM APP.T');
        expect(await reader.read()).toBe(true);
        expect(reader.getValue(0)).toBe(9223372036854775807n);
        expect(reader.getValue(1)).toBe('1234567890123.123456789012345678');
        await reader.close();
        expect(harness.reader.fieldCount).toBe(2);
    });

    it('forwards driver notices and close events through the connection boundary', async () => {
        const harness = createDriverHarness();
        const connection = new Db2Connection(connectionConfig, harness.factory);
        const notice = { sqlCode: 100, sqlState: '02000', message: 'No rows found' };
        const onNotice = jest.fn();
        const onClose = jest.fn();
        connection.on('notice', onNotice);
        connection.on('close', onClose);

        harness.driver.emit('notice', notice);
        await connection.close();

        expect(onNotice).toHaveBeenCalledWith(notice);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('redacts a configured password from connection errors and their stack', async () => {
        const secret = connectionConfig.password!;
        const harness = createDriverHarness({ connectError: new Error(`Authentication failed for ${secret}`) });
        const connection = new Db2Connection(connectionConfig, harness.factory);

        let caught: Error | undefined;
        try {
            await connection.connect();
        } catch (error) {
            caught = error as Error;
        }

        expect(caught).toBeDefined();
        expect(caught?.message).toContain('[redacted]');
        expect(caught?.message).not.toContain(secret);
        expect(caught?.stack).not.toContain(secret);
        expect(caught?.cause).toBeUndefined();
    });

    it('reports the failed target and user without the password on connect errors', async () => {
        const harness = createDriverHarness({ connectError: new Error('DB2 socket closed by peer') });
        const connection = new Db2Connection(connectionConfig, harness.factory);

        const caught = await connection.connect().then(
            () => undefined,
            (error: Error) => error
        );

        expect(caught?.message).toBe(
            'Failed to connect to Db2: DB2 socket closed by peer\n' +
            'Connection details: database=TESTDB, host=db2.example.local, port=50000, user=db2inst1'
        );
        expect(caught?.message).not.toContain(connectionConfig.password!);
        expect(connection._connected).toBe(false);
    });

    it('masks the password even when the driver echoes it inside the connection context', async () => {
        const secret = connectionConfig.password!;
        const config: DatabaseConnectionConfig = { ...connectionConfig, user: secret };
        const harness = createDriverHarness({ connectError: new Error(`bad credentials for ${secret}`) });
        const connection = new Db2Connection(config, harness.factory);

        const caught = await connection.connect().then(
            () => undefined,
            (error: Error) => error
        );

        expect(caught?.message).toContain('user=[redacted]');
        expect(caught?.message).not.toContain(secret);
    });
});
