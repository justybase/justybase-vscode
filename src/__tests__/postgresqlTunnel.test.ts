import { createRequire } from 'node:module';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { SecretStorage } from 'vscode';
import { PostgreSqlTunnelManager, type PostgreSqlTunnelProfile } from '../../extensions/postgresql/src/postgresqlTunnel';

const testRequire = createRequire(__filename);

interface TestWebSocket {
    on(event: 'message', listener: (data: Buffer) => void): this;
    send(data: Buffer | string): void;
}

interface TestWebSocketServer {
    on(event: 'connection', listener: (socket: TestWebSocket, request: { headers: { authorization?: string }; url?: string }) => void): this;
    close(callback: () => void): void;
}

interface TestWebSocketModule {
    WebSocketServer: new (options: { port: number; host: string }) => TestWebSocketServer;
}

interface TestState {
    value?: unknown[];
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
}

class MemoryState implements TestState {
    public value?: unknown[];

    public get<T>(_key: string, defaultValue?: T): T | undefined {
        return (this.value as T | undefined) ?? defaultValue;
    }

    public async update(_key: string, value: unknown): Promise<void> {
        this.value = value as unknown[];
    }
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

function startWebSocketServer(mode: 'echo' | 'text' = 'echo'): Promise<{ server: TestWebSocketServer; port: number; requests: string[] }> {
    const WebSocketModule = testRequire('ws') as TestWebSocketModule;
    const requests: string[] = [];
    const server = new WebSocketModule.WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.on('connection', (socket, request) => {
        requests.push(`${request.headers.authorization ?? ''} ${request.url ?? ''}`);
        if (mode === 'text') {
            socket.send('not-postgres-wire-data');
            return;
        }
        socket.on('message', data => socket.send(data));
    });
    return new Promise(resolve => {
        const candidate = server as TestWebSocketServer & { address(): AddressInfo | null };
        const waitForListening = (): void => {
            const address = candidate.address();
            if (address) resolve({ server, port: address.port, requests });
        };
        (server as TestWebSocketServer & { on(event: 'listening', listener: () => void): TestWebSocketServer }).on('listening', waitForListening);
    });
}

function closeWebSocketServer(server: TestWebSocketServer): Promise<void> {
    return new Promise(resolve => server.close(resolve));
}

function readData(socket: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const onData = (data: Buffer): void => {
            socket.removeListener('error', onError);
            resolve(Buffer.from(data));
        };
        const onError = (error: Error): void => {
            socket.removeListener('data', onData);
            reject(error);
        };
        socket.once('data', onData);
        socket.once('error', onError);
    });
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
    return new Promise(resolve => {
        const onClose = (): void => {
            socket.removeListener('error', onError);
            resolve();
        };
        const onError = (): void => {
            socket.removeListener('close', onClose);
            resolve();
        };
        socket.once('close', onClose);
        socket.once('error', onError);
    });
}

function getFreeLocalPort(): Promise<number> {
    const server = net.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

const profile: PostgreSqlTunnelProfile = {
    id: 'reports',
    name: 'Reports tunnel',
    serverUrl: 'http://127.0.0.1',
    targetId: 'reports',
    localPort: 1,
};

describe('PostgreSqlTunnelManager', () => {
    it('persists non-secret profile data and stores the token separately', async () => {
        const state = new MemoryState();
        const secrets = new MemorySecrets();
        const manager = new PostgreSqlTunnelManager(state, secrets as unknown as SecretStorage);

        await manager.saveProfile({ ...profile, serverUrl: 'https://gateway.example.com/' }, 'secret-token');

        expect(await manager.listProfiles()).toEqual([{ ...profile, serverUrl: 'https://gateway.example.com' }]);
        expect(await manager.getToken(profile.id)).toBe('secret-token');
        expect(JSON.stringify(state.value)).not.toContain('secret-token');
    });

    const networkTest = process.env.JUSTYBASE_POSTGRESQL_TUNNEL_TEST === '1' ? it : it.skip;

    networkTest('relays bytes in both directions and sends the named target with bearer auth', async () => {
        const websocket = await startWebSocketServer();
        const manager = new PostgreSqlTunnelManager(new MemoryState(), new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();

        try {
            const status = await manager.startWithToken({ ...profile, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort }, 'secret-token');
            const socket = net.createConnection({ host: status.host, port: status.localPort });
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
            socket.write(Buffer.from('postgres-wire-data'));
            await expect(readData(socket)).resolves.toEqual(Buffer.from('postgres-wire-data'));
            expect(websocket.requests).toEqual(['Bearer secret-token /tunnel/reports']);
            socket.destroy();
        } finally {
            await manager.stop(profile.id);
            await closeWebSocketServer(websocket.server);
        }
    });

    networkTest('rejects text WebSocket frames instead of forwarding them to PostgreSQL', async () => {
        const websocket = await startWebSocketServer('text');
        const manager = new PostgreSqlTunnelManager(new MemoryState(), new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();
        let socket: net.Socket | undefined;

        try {
            await manager.startWithToken({ ...profile, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort }, 'secret-token');
            const localSocket = net.createConnection({ host: '127.0.0.1', port: localPort });
            socket = localSocket;
            await new Promise<void>((resolve, reject) => {
                localSocket.once('connect', () => resolve());
                localSocket.once('error', reject);
            });
            await waitForSocketClose(localSocket);
            expect(websocket.requests).toEqual(['Bearer secret-token /tunnel/reports']);
        } finally {
            socket?.destroy();
            await manager.stop(profile.id);
            await closeWebSocketServer(websocket.server);
        }
    });

    networkTest('closes a listener that is stopped while listen is pending', async () => {
        const websocket = await startWebSocketServer();
        const manager = new PostgreSqlTunnelManager(new MemoryState(), new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();

        try {
            const starting = manager.startWithToken({ ...profile, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort }, 'secret-token');
            const stopping = manager.stop(profile.id);
            await expect(starting).rejects.toThrow('stopped while it was starting');
            await stopping;
            expect(manager.getStatuses()).toEqual([]);

            const restarted = await manager.startWithToken({ ...profile, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort }, 'secret-token');
            expect(restarted.localPort).toBe(localPort);
            await manager.stop(profile.id);
        } finally {
            await manager.stop(profile.id);
            await closeWebSocketServer(websocket.server);
        }
    });
});
