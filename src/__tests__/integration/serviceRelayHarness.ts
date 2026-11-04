import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { SecretStorage } from 'vscode';

const SAMPLE_DIRECTORY = path.resolve(__dirname, '../../../samples/database-tunnel-service');

export const SERVICE_LOGIN = 'analyst';

export class MemorySecrets {
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

    public asSecretStorage(): SecretStorage {
        return this as unknown as SecretStorage;
    }
}

export function getFreeLocalPort(): Promise<number> {
    const server = net.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function resolvePythonExecutable(): string {
    const configured = process.env.DATABASE_TUNNEL_PYTHON?.trim();
    if (configured) return configured;
    const candidate = process.platform === 'win32'
        ? path.join(SAMPLE_DIRECTORY, '.venv', 'Scripts', 'python.exe')
        : path.join(SAMPLE_DIRECTORY, '.venv', 'bin', 'python');
    return fs.existsSync(candidate) ? candidate : 'python3';
}

export interface StartedServiceRelay {
    baseUrl: string;
    servicePassword: string;
    stop(): Promise<void>;
}

/** Start the sample service. `targets` follows JUSTYBASE_RELAY_TARGETS_JSON. */
export async function startServiceRelay(
    targets: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
): Promise<StartedServiceRelay> {
    const port = await getFreeLocalPort();
    const servicePassword = randomBytes(16).toString('hex');
    let stderr = '';
    const child: ChildProcess = spawn(
        resolvePythonExecutable(),
        [
            '-m', 'uvicorn', 'demo_service.app:create_app', '--factory',
            '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning',
        ],
        {
            cwd: SAMPLE_DIRECTORY,
            env: {
                ...process.env,
                ...extraEnv,
                JUSTYBASE_RELAY_TARGETS_JSON: JSON.stringify(targets),
                DEMO_JWT_SECRET: randomBytes(32).toString('hex'),
                DEMO_USERNAME: SERVICE_LOGIN,
                DEMO_PASSWORD: servicePassword,
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        },
    );
    child.stderr?.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });

    const stop = (): Promise<void> => new Promise(resolve => {
        if (child.exitCode !== null) {
            resolve();
            return;
        }
        child.once('exit', () => resolve());
        child.kill();
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (response.ok) {
                return { baseUrl: `http://127.0.0.1:${port}/api/justybase`, servicePassword, stop };
            }
        } catch {
            // The service is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await stop();
    throw new Error(`The sample service did not start: ${stderr}`);
}
