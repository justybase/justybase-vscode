import { createRequire } from 'node:module';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { SecretStorage } from 'vscode';
import type { DatabaseTunnelConfig } from '../../contracts/database';
import { DatabaseTunnelManager } from '../../core/databaseTunnel';

const testRequire = createRequire(__filename);

interface TestWebSocket {
    on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): this;
    send(data: Buffer | string): void;
}

interface TestWebSocketServer {
    on(
        event: 'connection',
        listener: (
            socket: TestWebSocket,
            request: { headers: { authorization?: string }; url?: string },
        ) => void,
    ): this;
    close(callback: () => void): void;
    address(): AddressInfo | null;
}

interface TestWebSocketModule {
    WebSocketServer: new (options: { port: number; host: string }) => TestWebSocketServer;
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

function startWebSocketServer(
    mode: 'echo' | 'text' = 'echo',
): Promise<{ server: TestWebSocketServer; port: number; requests: string[] }> {
    const WebSocketModule = testRequire('ws') as TestWebSocketModule;
    const requests: string[] = [];
    const server = new WebSocketModule.WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.on('connection', (socket, request) => {
        requests.push(`${request.headers.authorization ?? ''} ${request.url ?? ''}`);
        if (mode === 'text') {
            socket.send('not-postgres-wire-data');
            return;
        }
        socket.on('message', (data) => socket.send(data));
    });
    return new Promise((resolve) => {
        const waitForListening = (): void => {
            const address = server.address();
            if (address) resolve({ server, port: address.port, requests });
        };
        (server as TestWebSocketServer & {
            on(event: 'listening', listener: () => void): TestWebSocketServer;
        }).on('listening', waitForListening);
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

const tunnelConfig: DatabaseTunnelConfig = {
    id: 'reports',
    serverUrl: 'http://127.0.0.1',
    targetId: 'reports',
    localPort: 15432,
};

describe('DatabaseTunnelManager', () => {
    it('stores bearer tokens in SecretStorage and exposes no token in status', async () => {
        const secrets = new MemorySecrets();
        const manager = new DatabaseTunnelManager(secrets as unknown as SecretStorage);

        await manager.storeToken(tunnelConfig.id, 'secret-token');

        expect(await manager.getToken(tunnelConfig.id)).toBe('secret-token');
        expect(JSON.stringify(manager.getStatuses())).not.toContain('secret-token');
    });

    it('restarts a listening tunnel when its bearer token changes', async () => {
        const websocket = await startWebSocketServer();
        const manager = new DatabaseTunnelManager(new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();
        const config = { ...tunnelConfig, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort };

        try {
            await manager.ensureStarted(config, 'first-token');
            await manager.ensureStarted(config, 'second-token');

            const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
            socket.write(Buffer.from('token-refresh'));
            await expect(readData(socket)).resolves.toEqual(Buffer.from('token-refresh'));
            expect(websocket.requests).toEqual(['Bearer second-token /tunnel/reports']);
            socket.destroy();
        } finally {
            await manager.stop(config.id);
            await closeWebSocketServer(websocket.server);
        }
    });

    it('relays bytes in both directions and sends the named target with bearer auth', async () => {
        const websocket = await startWebSocketServer();
        const manager = new DatabaseTunnelManager(new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();
        const config = { ...tunnelConfig, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort };
        let socket: net.Socket | undefined;

        try {
            const endpoint = await manager.ensureStarted(config, 'secret-token');
            socket = net.createConnection(endpoint);
            await new Promise<void>((resolve, reject) => {
                socket?.once('connect', () => resolve());
                socket?.once('error', reject);
            });
            socket.write(Buffer.from('postgres-wire-data'));

            await expect(readData(socket)).resolves.toEqual(Buffer.from('postgres-wire-data'));
            expect(websocket.requests).toEqual(['Bearer secret-token /tunnel/reports']);
        } finally {
            socket?.destroy();
            await manager.stop(config.id);
            await closeWebSocketServer(websocket.server);
        }
    });

    it('rejects text WebSocket frames instead of forwarding them to a database driver', async () => {
        const websocket = await startWebSocketServer('text');
        const manager = new DatabaseTunnelManager(new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();
        const config = { ...tunnelConfig, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort };
        let socket: net.Socket | undefined;

        try {
            await manager.ensureStarted(config, 'secret-token');
            socket = net.createConnection({ host: '127.0.0.1', port: localPort });
            await new Promise<void>((resolve, reject) => {
                socket?.once('connect', () => resolve());
                socket?.once('error', reject);
            });
            await waitForSocketClose(socket);
            expect(websocket.requests).toEqual(['Bearer secret-token /tunnel/reports']);
        } finally {
            socket?.destroy();
            await manager.stop(config.id);
            await closeWebSocketServer(websocket.server);
        }
    });

    it('closes a listener that is stopped while listen is pending', async () => {
        const websocket = await startWebSocketServer();
        const manager = new DatabaseTunnelManager(new MemorySecrets() as unknown as SecretStorage);
        const localPort = await getFreeLocalPort();
        const config = { ...tunnelConfig, serverUrl: `http://127.0.0.1:${websocket.port}`, localPort };

        try {
            const starting = manager.ensureStarted(config, 'secret-token');
            const stopping = manager.stop(config.id);

            await expect(starting).rejects.toThrow('stopped while it was starting');
            await stopping;
            expect(manager.getStatuses()).toEqual([]);

            const restarted = await manager.ensureStarted(config, 'secret-token');
            expect(restarted.port).toBe(localPort);
            await manager.stop(config.id);
        } finally {
            await manager.stop(config.id);
            await closeWebSocketServer(websocket.server);
        }
    });
});
