import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { SecretStorage } from 'vscode';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import {
    configureDatabaseTunnelRuntime,
    createConnectedDatabaseConnectionFromDetails,
} from '../../core/connectionFactory';
import { DatabaseTunnelManager } from '../../core/databaseTunnel';
import type { DatabaseConnection } from '../../contracts/database';
import { postgresqlDialect } from '../../../extensions/postgresql/src/postgresqlDialect';

type LiveDatabase = 'postgresql' | 'netezza';

interface LiveDatabaseConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
}

class MemorySecrets {
    private readonly values = new Map<string, string>();

    public async get(key: string): Promise<string | undefined> {
        return this.values.get(key);
    }

    public async store(key: string, value: string): Promise<void> {
        this.values.set(key, value);
    }

    public async delete(key: string): Promise<void> {
        this.values.delete(key);
    }
}

function readRequired(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required live tunnel test environment variable: ${name}`);
    }
    return value;
}

function readPort(name: string, fallback?: number): number {
    const raw = process.env[name]?.trim();
    if (!raw && fallback !== undefined) return fallback;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid live tunnel test port in environment variable: ${name}`);
    }
    return port;
}

function readPostgreSqlConfig(): LiveDatabaseConfig {
    const firstValue = (suffix: string): string => readRequired(
        process.env[`POSTGRES_LIVE_TEST_${suffix}`]?.trim()
            ? `POSTGRES_LIVE_TEST_${suffix}`
            : `PG_LIVE_TEST_${suffix}`,
    );
    const portName = process.env.POSTGRES_LIVE_TEST_PORT?.trim()
        ? 'POSTGRES_LIVE_TEST_PORT'
        : 'PG_LIVE_TEST_PORT';
    return {
        host: firstValue('HOST'),
        port: readPort(portName, 5432),
        database: firstValue('DATABASE'),
        user: firstValue('USER'),
        password: firstValue('PASSWORD'),
    };
}

function readNetezzaConfig(): LiveDatabaseConfig {
    return {
        host: readRequired('NZ_DEV_HOST'),
        port: readPort('NZ_DEV_PORT', 5480),
        database: readRequired('NZ_DEV_DATABASE'),
        user: readRequired('NZ_DEV_USER'),
        password: readRequired('NZ_DEV_PASSWORD'),
    };
}

function selectedDatabases(): LiveDatabase[] {
    const requested = process.env.JUSTYBASE_TUNNEL_LIVE_DATABASE?.trim().toLowerCase();
    if (!requested) return ['postgresql', 'netezza'];
    if (requested === 'postgresql' || requested === 'postgres') return ['postgresql'];
    if (requested === 'netezza' || requested === 'nz') return ['netezza'];
    throw new Error(`Unsupported JUSTYBASE_TUNNEL_LIVE_DATABASE value: ${requested}`);
}

const databases = selectedDatabases();
const liveConfigs: Partial<Record<LiveDatabase, LiveDatabaseConfig>> = {};
for (const database of databases) {
    liveConfigs[database] = database === 'postgresql'
        ? readPostgreSqlConfig()
        : readNetezzaConfig();
}

const relayDirectory = path.resolve(__dirname, '../../../samples/database-tunnel');

function resolvePythonExecutable(): string {
    const configured = process.env.DATABASE_TUNNEL_PYTHON?.trim();
    if (configured) return configured;

    const virtualEnvironmentPython = process.platform === 'win32'
        ? path.join(relayDirectory, '.venv', 'Scripts', 'python.exe')
        : path.join(relayDirectory, '.venv', 'bin', 'python');
    return fs.existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3';
}

function getFreeLocalPort(): Promise<number> {
    const server = net.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as AddressInfo;
            server.close(error => error ? reject(error) : resolve(address.port));
        });
    });
}

async function waitForRelay(child: ChildProcess, port: number, stderr: string[]): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError = 'relay health endpoint did not become ready';
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`FastAPI tunnel relay exited before readiness: ${stderr.join('').slice(-2000)}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (response.ok) return;
            lastError = `relay returned HTTP ${response.status}`;
        } catch (error: unknown) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`FastAPI tunnel relay was not ready: ${lastError}`);
}

async function stopRelay(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
        const finish = (): void => resolve();
        child.once('exit', finish);
        child.kill('SIGTERM');
        setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
        }, 5_000).unref();
    });
}

async function readScalar(connection: DatabaseConnection, sql: string): Promise<unknown> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        expect(await reader.read()).toBe(true);
        return reader.getValue(0);
    } finally {
        await reader.close();
    }
}

describe('live core database tunnel through the FastAPI relay', () => {
    const token = `justybase-live-tunnel-${Date.now()}`;
    const secrets = new MemorySecrets();
    const tunnelManager = new DatabaseTunnelManager(secrets as unknown as SecretStorage);
    let relay: ChildProcess | undefined;
    let relayPort: number;

    beforeAll(async () => {
        ensureBuiltInDialectsRegistered();
        registerDatabaseDialect(postgresqlDialect);

        relayPort = await getFreeLocalPort();
        const targets = Object.fromEntries(
            databases.map(database => [database, {
                host: liveConfigs[database]!.host,
                port: liveConfigs[database]!.port,
            }]),
        );
        const stderr: string[] = [];
        relay = spawn(
            resolvePythonExecutable(),
            ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(relayPort)],
            {
                cwd: relayDirectory,
                env: {
                    ...process.env,
                    DATABASE_TUNNEL_BIND_HOST: '127.0.0.1',
                    DATABASE_TUNNEL_BIND_PORT: String(relayPort),
                    DATABASE_TUNNEL_TOKEN: token,
                    DATABASE_TUNNEL_TARGETS_JSON: JSON.stringify(targets),
                },
                stdio: ['ignore', 'ignore', 'pipe'],
            },
        );
        relay.stderr?.on('data', chunk => stderr.push(String(chunk)));
        await waitForRelay(relay, relayPort, stderr);
        configureDatabaseTunnelRuntime(tunnelManager);
    }, 60_000);

    afterAll(async () => {
        configureDatabaseTunnelRuntime(undefined);
        await tunnelManager.stopAll();
        await stopRelay(relay);
    });

    for (const database of databases) {
        it(`connects to ${database} through a named raw TCP target`, async () => {
            const config = liveConfigs[database]!;
            const tunnelId = `live-${database}`;
            const localPort = await getFreeLocalPort();
            const details = {
                name: `live tunnel ${database}`,
                host: '127.0.0.1',
                port: localPort,
                database: config.database,
                user: config.user,
                password: config.password,
                dbType: database,
                tunnel: {
                    id: tunnelId,
                    serverUrl: `http://127.0.0.1:${relayPort}`,
                    targetId: database,
                    localPort,
                },
            } as const;

            await tunnelManager.storeToken(tunnelId, token);
            const connection = await createConnectedDatabaseConnectionFromDetails(details);
            try {
                await expect(readScalar(connection, 'SELECT 1 AS TUNNEL_VALUE')).resolves.toEqual(1);
            } finally {
                await connection.close();
                await tunnelManager.stop(tunnelId);
                await tunnelManager.deleteToken(tunnelId);
            }
        }, 60_000);
    }
});
