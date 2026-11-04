import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DatabaseConnection, DatabaseDataReader } from '../../contracts/database';
import {
    configureDatabaseTunnelRuntime,
    createConnectedDatabaseConnectionFromDetails,
} from '../../core/connectionFactory';
import type { DatabaseConnectionDetails } from '../../core/connectionFactoryTypes';
import { DatabaseTunnelManager } from '../../core/databaseTunnel';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { registerNetezzaImportStream } from '../../import/netezzaVirtualImport';
import {
    getFreeLocalPort,
    MemorySecrets,
    SERVICE_LOGIN,
    startServiceRelay,
    type StartedServiceRelay,
} from './serviceRelayHarness';

/*
 * The client knows only a service login and password. The database account
 * comes from the relay. A missing variable is a failure, not a skipped test, so
 * a green result means the real database was exercised.
 *
 * JUSTYBASE_RELAY_LIVE_TLS selects the relay-to-database mode (default "prefer").
 * For a database whose certificate cannot be verified, either use "off", or set
 * JUSTYBASE_RELAY_LIVE_TLS_VERIFY=false to encrypt without checking it.
 */

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing required live relay test environment variable: ${name}`);
    return value;
}

const live = {
    host: required('NZ_DEV_HOST'),
    port: Number(process.env.NZ_DEV_PORT?.trim() || 5480),
    database: required('NZ_DEV_DATABASE'),
    user: required('NZ_DEV_USER'),
};
required('NZ_DEV_PASSWORD');

async function readRows(connection: DatabaseConnection, sql: string): Promise<unknown[][]> {
    const reader: DatabaseDataReader = await connection.createCommand(sql).executeReader();
    const rows: unknown[][] = [];
    try {
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index++) row.push(reader.getValue(index));
            rows.push(row);
        }
    } finally {
        await reader.close();
    }
    return rows;
}

async function scalar(connection: DatabaseConnection, sql: string): Promise<unknown> {
    return (await readRows(connection, sql))[0]?.[0];
}

const MISSING_DATABASE_USER = 'JB_RELAY_NO_SUCH_USER';

function uniqueName(prefix: string): string {
    return `${prefix}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

describe('Netezza through the service relay (live)', () => {
    let relay: StartedServiceRelay;
    let manager: DatabaseTunnelManager;
    let connection: DatabaseConnection;
    let profile: DatabaseConnectionDetails;

    beforeAll(async () => {
        ensureBuiltInDialectsRegistered();
        const tlsSettings = {
            tls: process.env.JUSTYBASE_RELAY_LIVE_TLS?.trim() || 'prefer',
            ...(process.env.JUSTYBASE_RELAY_LIVE_TLS_VERIFY?.trim() === 'false' ? { tls_verify: false } : {}),
        };
        relay = await startServiceRelay(
            {
                netezza: {
                    host: live.host,
                    port: live.port,
                    user_env: 'NZ_DEV_USER',
                    password_env: 'NZ_DEV_PASSWORD',
                    ...tlsSettings,
                },
                // An account that does not exist, so no real account can be locked.
                refused: {
                    host: live.host,
                    port: live.port,
                    user_env: 'JB_RELAY_LIVE_MISSING_USER',
                    password_env: 'NZ_DEV_PASSWORD',
                    ...tlsSettings,
                },
                restricted: {
                    host: live.host,
                    port: live.port,
                    user_env: 'NZ_DEV_USER',
                    password_env: 'NZ_DEV_PASSWORD',
                    allowed_databases: ['JB_RELAY_NOT_THIS_DATABASE'],
                    ...tlsSettings,
                },
            },
            { JB_RELAY_LIVE_MISSING_USER: MISSING_DATABASE_USER },
        );
        manager = new DatabaseTunnelManager(new MemorySecrets().asSecretStorage());
        configureDatabaseTunnelRuntime(manager);
        profile = {
            name: 'service-relay-live',
            host: '127.0.0.1',
            port: 15480,
            database: live.database,
            user: SERVICE_LOGIN,
            dbType: 'netezza',
            tunnel: {
                id: 'service-relay-live',
                serverUrl: relay.baseUrl,
                targetId: 'netezza',
                localPort: await getFreeLocalPort(),
                auth: 'service-login',
            },
        };
        connection = await createConnectedDatabaseConnectionFromDetails(profile, undefined, {
            tunnelToken: relay.servicePassword,
        });
    }, 90_000);

    afterAll(async () => {
        await connection?.close().catch(() => undefined);
        await manager?.stopAll();
        configureDatabaseTunnelRuntime(undefined);
        await relay?.stop();
    }, 30_000);

    it('runs as the database account the relay holds, not the service login', async () => {
        const user = String(await scalar(connection, 'SELECT CURRENT_USER'));

        expect(user.toUpperCase()).toBe(live.user.toUpperCase());
        expect(user.toUpperCase()).not.toBe(SERVICE_LOGIN.toUpperCase());
    }, 60_000);

    it('keeps session state between statements', async () => {
        const table = uniqueName('JB_RELAY');
        await connection.createCommand(`CREATE TEMP TABLE ${table} (ID INT) DISTRIBUTE ON RANDOM`).execute();
        await connection.createCommand(`INSERT INTO ${table} VALUES (1)`).execute();

        expect(Number(await scalar(connection, `SELECT COUNT(*) FROM ${table}`))).toBe(1);
    }, 60_000);

    it('delivers EXPLAIN text as notices', async () => {
        const notices: string[] = [];
        const listener = (notice: unknown): void => {
            notices.push(String((notice as { message?: unknown }).message ?? ''));
        };
        connection.on('notice', listener);
        try {
            await readRows(connection, 'EXPLAIN VERBOSE SELECT * FROM _V_OBJECT_DATA LIMIT 1').catch(() => undefined);
        } finally {
            connection.removeListener('notice', listener);
        }

        expect(notices.join('\n').length).toBeGreaterThan(0);
    }, 60_000);

    it('streams an external table import through the relay', async () => {
        const table = uniqueName('JB_RELAY_IMPORT');
        const source = `jb_relay_${randomBytes(4).toString('hex')}.txt`;
        await connection.createCommand(`CREATE TEMP TABLE ${table} (ID INT, TXT VARCHAR(20)) DISTRIBUTE ON RANDOM`).execute();

        const unregister = registerNetezzaImportStream(source, Readable.from(['1|a\n2|b\n3|c\n']));
        try {
            await connection.createCommand(
                `INSERT INTO ${table} SELECT * FROM EXTERNAL '${source}' (ID INT, TXT VARCHAR(20)) `
                + `USING (DELIM '|' REMOTESOURCE 'jdbc')`,
            ).execute();
        } finally {
            unregister();
        }

        expect(Number(await scalar(connection, `SELECT COUNT(*) FROM ${table}`))).toBe(3);
    }, 90_000);

    it('cancels a running query and keeps the session usable', async () => {
        const command = connection.createCommand(
            'SELECT COUNT(*) FROM _V_RELATION_COLUMN A, _V_RELATION_COLUMN B, _V_RELATION_COLUMN C, _V_RELATION_COLUMN D',
        );
        const started = Date.now();
        const running = command.executeReader().then(
            async reader => {
                await reader.read();
                await reader.close();
                return 'finished';
            },
            () => 'cancelled',
        );
        await new Promise(resolve => setTimeout(resolve, 1500));
        await command.cancel();

        await expect(running).resolves.toBe('cancelled');
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(Number(await scalar(connection, 'SELECT 1'))).toBe(1);
    }, 90_000);

    it('opens several sessions at once, as metadata loading does', async () => {
        const extra = await Promise.all(
            [1, 2, 3].map(() => createConnectedDatabaseConnectionFromDetails(profile, undefined, {
                tunnelToken: relay.servicePassword,
            })),
        );
        try {
            const sessions = await Promise.all(extra.map(item => scalar(item, 'SELECT CURRENT_SID')));
            expect(new Set(sessions.map(String)).size).toBe(3);
        } finally {
            await Promise.all(extra.map(item => item.close()));
        }
    }, 90_000);

    describe('refusals', () => {
        async function profileFor(targetId: string, id: string): Promise<DatabaseConnectionDetails> {
            return {
                ...profile,
                name: id,
                tunnel: {
                    ...profile.tunnel!,
                    id,
                    targetId,
                    localPort: await getFreeLocalPort(),
                },
            };
        }

        it('refuses a wrong service password before any database connection', async () => {
            const wrong = await profileFor('netezza', 'live-wrong-password');

            await expect(createConnectedDatabaseConnectionFromDetails(wrong, undefined, {
                tunnelToken: 'not-the-service-password',
            })).rejects.toThrow('The service rejected the login or password.');
        }, 60_000);

        it('refuses a local process without the client proof, on the real database path', async () => {
            const { NzConnection } = jest.requireActual('@justybase/netezza-driver') as {
                NzConnection: new (config: Record<string, unknown>) => {
                    connect(): Promise<void>;
                    close(): Promise<void>;
                };
            };
            const intruder = new NzConnection({
                host: '127.0.0.1',
                port: profile.tunnel!.localPort,
                database: live.database,
                user: 'someone',
                password: 'guess',
                clientType: 11,
                connectionTimeout: 20,
            });

            await expect(intruder.connect()).rejects.toThrow('Invalid client proof');
            await intruder.close().catch(() => undefined);
        }, 60_000);

        it('hides the account name when the database refuses the service account', async () => {
            const refused = await profileFor('refused', 'live-refused-account');

            const failure = await createConnectedDatabaseConnectionFromDetails(refused, undefined, {
                tunnelToken: relay.servicePassword,
            }).then(
                async opened => {
                    await opened.close();
                    return new Error('connected unexpectedly');
                },
                (error: Error) => error,
            );

            expect(failure.message).toContain('The relay could not log in to the database');
            expect(failure.message).not.toContain(MISSING_DATABASE_USER);
        }, 60_000);

        it('refuses a database outside the target allowlist', async () => {
            const restricted = await profileFor('restricted', 'live-restricted');

            await expect(createConnectedDatabaseConnectionFromDetails(restricted, undefined, {
                tunnelToken: relay.servicePassword,
            })).rejects.toThrow('is not available through this relay target');
        }, 60_000);
    });
});
