import { createHash } from 'node:crypto';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { DatabaseConnection } from '../../contracts/database';
import {
    configureDatabaseTunnelRuntime,
    createConnectedDatabaseConnectionFromDetails,
} from '../../core/connectionFactory';
import { DatabaseTunnelManager } from '../../core/databaseTunnel';
import type { DatabaseConnectionDetails } from '../../core/connectionFactoryTypes';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import {
    getFreeLocalPort,
    MemorySecrets,
    SERVICE_LOGIN,
    startServiceRelay,
    type StartedServiceRelay,
} from './serviceRelayHarness';

/*
 * Real Netezza driver -> real tunnel manager -> real sample relay -> scripted
 * Netezza server. No database is needed. This checks that the relay's handshake
 * matches what the driver actually sends. Whether a real Netezza accepts it is
 * checked by databaseTunnelServiceLogin.live.integration.test.ts.
 */

const DB_USER = 'NZ_SERVICE';
const DB_PASSWORD = 'database-only-password';
const SALT = Buffer.from([7, 9]);
const BACKEND_PID = 4321;
const BACKEND_KEY = 8765;
const CANCEL_CODE = 80877102;
const HSV2_DB = 2;
const HSV2_USER = 3;
const HSV2_CLIENT_TYPE = 8;
const HSV2_SSL_NEGOTIATE = 11;
const HSV2_CLIENT_DONE = 1000;

class SocketReader {
    private buffer = Buffer.alloc(0);
    private waiter: (() => void) | undefined;
    private ended = false;

    public constructor(socket: net.Socket) {
        socket.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.waiter?.();
        });
        const onEnd = (): void => {
            this.ended = true;
            this.waiter?.();
        };
        socket.on('close', onEnd);
        socket.on('error', onEnd);
    }

    public async read(count: number): Promise<Buffer> {
        while (this.buffer.length < count) {
            if (this.ended) throw new Error('socket closed');
            await new Promise<void>(resolve => {
                this.waiter = resolve;
            });
        }
        const chunk = this.buffer.subarray(0, count);
        this.buffer = this.buffer.subarray(count);
        return chunk;
    }
}

function int32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
}

class ScriptedNetezza {
    public frames = new Map<number, Buffer>();
    public levels: number[] = [];
    public clientBytesAfterLogin = 0;
    public cancelFrame: Buffer | undefined;
    public acceptPassword = true;
    private loggedInSocket: net.Socket | undefined;
    private readonly server = net.createServer(socket => {
        socket.on('error', () => undefined);
        void this.serve(socket).catch(() => socket.destroy());
    });

    public async start(): Promise<number> {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        return (this.server.address() as AddressInfo).port;
    }

    public async stop(): Promise<void> {
        this.loggedInSocket?.destroy();
        await new Promise(resolve => this.server.close(resolve));
    }

    private async serve(socket: net.Socket): Promise<void> {
        const reader = new SocketReader(socket);
        while (true) {
            const length = (await reader.read(4)).readInt32BE();
            const body = await reader.read(length - 4);
            if (length === 16 && body.readInt32BE() === CANCEL_CODE) {
                this.cancelFrame = Buffer.from(body);
                socket.destroy();
                this.loggedInSocket?.destroy();
                return;
            }
            const opcode = body.readInt16BE();
            this.frames.set(opcode, Buffer.from(body.subarray(2)));
            if (opcode === HSV2_SSL_NEGOTIATE) this.levels.push(body.readInt32BE(2));
            if (opcode === HSV2_CLIENT_DONE) break;
            socket.write('N');
        }

        socket.write(Buffer.concat([Buffer.from('R'), int32(6), SALT]));
        const length = (await reader.read(4)).readInt32BE();
        const answer = (await reader.read(length - 4)).subarray(0, -1).toString('utf8');
        const expected = createHash('sha256')
            .update(Buffer.concat([SALT, Buffer.from(DB_PASSWORD)]))
            .digest('base64')
            .replace(/=+$/, '');
        if (!this.acceptPassword || answer !== expected) {
            socket.end(Buffer.from('EPassword authentication failed for NZ_SERVICE\0'));
            return;
        }

        this.loggedInSocket = socket;
        socket.write(Buffer.concat([
            Buffer.from('R'), int32(0),
            Buffer.from('K'), int32(0), int32(0), int32(BACKEND_PID), int32(BACKEND_KEY),
            Buffer.from('Z'), int32(0),
        ]));
        while (true) {
            this.clientBytesAfterLogin += (await reader.read(1)).length;
        }
    }
}

function cstring(buffer: Buffer | undefined): string {
    return buffer ? buffer.subarray(0, buffer.indexOf(0)).toString('utf8') : '';
}

describe('Netezza driver through the sample service relay', () => {
    let database: ScriptedNetezza;
    let relay: StartedServiceRelay;
    let manager: DatabaseTunnelManager;
    let secrets: MemorySecrets;
    const open: DatabaseConnection[] = [];

    async function details(overrides: Partial<DatabaseConnectionDetails> = {}): Promise<DatabaseConnectionDetails> {
        return {
            name: 'service-profile',
            host: '127.0.0.1',
            port: 15480,
            database: 'DEV',
            user: SERVICE_LOGIN,
            dbType: 'netezza',
            tunnel: {
                id: 'relay-test',
                serverUrl: relay.baseUrl,
                targetId: 'netezza',
                localPort: await getFreeLocalPort(),
                auth: 'service-login',
            },
            ...overrides,
        };
    }

    async function connect(profile: DatabaseConnectionDetails, password = relay.servicePassword): Promise<DatabaseConnection> {
        const connection = await createConnectedDatabaseConnectionFromDetails(profile, undefined, {
            tunnelToken: password,
        });
        open.push(connection);
        return connection;
    }

    beforeAll(async () => {
        ensureBuiltInDialectsRegistered();
        database = new ScriptedNetezza();
        const databasePort = await database.start();
        relay = await startServiceRelay(
            {
                netezza: {
                    host: '127.0.0.1',
                    port: databasePort,
                    user_env: 'TEST_DB_USER',
                    password_env: 'TEST_DB_PASSWORD',
                    allowed_databases: ['DEV'],
                },
            },
            { TEST_DB_USER: DB_USER, TEST_DB_PASSWORD: DB_PASSWORD },
        );
    }, 60_000);

    beforeEach(() => {
        secrets = new MemorySecrets();
        manager = new DatabaseTunnelManager(secrets.asSecretStorage());
        configureDatabaseTunnelRuntime(manager);
        database.frames.clear();
        database.levels = [];
        database.acceptPassword = true;
        database.cancelFrame = undefined;
    });

    afterEach(async () => {
        for (const connection of open.splice(0)) {
            await connection.close().catch(() => undefined);
        }
        await manager.stopAll();
        configureDatabaseTunnelRuntime(undefined);
    });

    afterAll(async () => {
        await relay?.stop();
        await database?.stop();
    });

    it('connects the real driver, with the relay replacing the user and answering the login', async () => {
        await connect(await details());

        expect(cstring(database.frames.get(HSV2_USER))).toBe(DB_USER);
        expect(cstring(database.frames.get(HSV2_DB))).toBe('DEV');
        expect(database.levels).toEqual([2]);
    }, 30_000);

    it('keeps the driver identity that DROP SESSION depends on', async () => {
        await connect(await details());

        expect(database.frames.get(HSV2_CLIENT_TYPE)?.readInt16BE()).toBe(11);
    }, 30_000);

    it('forwards the cancel request of the real driver', async () => {
        const connection = await connect(await details());

        const command = connection.createCommand('SELECT 1');
        const running = command.executeReader().then(
            reader => reader.close().then(() => 'finished'),
            () => 'failed',
        );
        await waitFor(() => database.clientBytesAfterLogin > 0);
        await command.cancel();
        await waitFor(() => database.cancelFrame !== undefined);
        await running;

        expect(database.cancelFrame!.readInt32BE(4)).toBe(BACKEND_PID);
        expect(database.cancelFrame!.readInt32BE(8)).toBe(BACKEND_KEY);
    }, 30_000);

    it('reports a wrong service password as a service login failure', async () => {
        await expect(connect(await details(), 'wrong-password')).rejects.toThrow(
            'The service rejected the login or password.',
        );
    }, 30_000);

    it('shows a generic error when the service account is refused, without naming it', async () => {
        database.acceptPassword = false;

        const failure = await connect(await details()).then(
            () => new Error('connected unexpectedly'),
            (error: Error) => error,
        );

        expect(failure.message).toContain('The relay could not log in to the database');
        expect(failure.message).not.toContain(DB_USER);
    }, 30_000);

    it('refuses a database outside the target allowlist', async () => {
        const profile = await details({ database: 'PROD' });

        await expect(connect(profile)).rejects.toThrow("Database 'PROD' is not available");
    }, 30_000);

    it('refuses a local process that reaches the listener without the client proof', async () => {
        const { NzConnection } = jest.requireActual('@justybase/netezza-driver') as {
            NzConnection: new (config: Record<string, unknown>) => { connect(): Promise<void>; close(): Promise<void> };
        };
        const profile = await details();
        await connect(profile);

        const intruder = new NzConnection({
            host: '127.0.0.1',
            port: profile.tunnel!.localPort,
            database: 'DEV',
            user: 'someone',
            password: 'guess',
            clientType: 11,
            connectionTimeout: 10,
        });

        await expect(intruder.connect()).rejects.toThrow('Invalid client proof');
        await intruder.close().catch(() => undefined);
    }, 30_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the expected condition.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
