import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { SecretStorage } from 'vscode';
import type { DatabaseTunnelConfig } from '../../contracts/database';
import { DatabaseTunnelManager, databaseTunnelSecretChangeMessage, isDatabaseTunnelRelayChanged } from '../../core/databaseTunnel';

const testRequire = createRequire(__filename);

interface ServerWebSocket {
    on(event: 'message', listener: (data: Buffer) => void): this;
    send(data: Buffer): void;
}

interface NoServerWebSocketServer {
    handleUpgrade(
        request: http.IncomingMessage,
        socket: Duplex,
        head: Buffer,
        callback: (websocket: ServerWebSocket) => void,
    ): void;
    close(callback?: () => void): void;
}

const { WebSocketServer } = testRequire('ws') as {
    WebSocketServer: new (options: { noServer: true }) => NoServerWebSocketServer;
};

const PASSWORD = 'service-secret-password';

class FakeRelay {
    public logins: { username: string; password: string }[] = [];
    public upgrades: { authorization?: string; proof?: string; url?: string }[] = [];
    public refuseTokens = new Set<string>();
    public loginDelayMs = 0;
    private nextToken = 1;
    private readonly webSockets = new WebSocketServer({ noServer: true });
    private readonly server = http.createServer((request, response) => this.handleLogin(request, response));

    public async start(): Promise<number> {
        this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        return (this.server.address() as AddressInfo).port;
    }

    public async stop(): Promise<void> {
        this.webSockets.close();
        this.server.closeAllConnections();
        await new Promise(resolve => this.server.close(resolve));
    }

    private handleLogin(request: http.IncomingMessage, response: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const login = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                username: string;
                password: string;
            };
            this.logins.push(login);
            setTimeout(() => {
                if (request.url !== '/base/auth/token' || login.password !== PASSWORD) {
                    response.writeHead(401).end('{}');
                    return;
                }
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ access_token: `jwt-${this.nextToken++}`, expires_in: 900 }));
            }, this.loginDelayMs);
        });
    }

    private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        const authorization = request.headers.authorization;
        this.upgrades.push({
            authorization,
            proof: request.headers['x-justybase-client-proof'] as string | undefined,
            url: request.url,
        });
        if (this.refuseTokens.has((authorization ?? '').replace('Bearer ', ''))) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        this.webSockets.handleUpgrade(request, socket, head, websocket => {
            websocket.on('message', data => websocket.send(data));
        });
    }
}

class MemorySecrets {
    public async get(): Promise<string | undefined> {
        return undefined;
    }

    public async store(): Promise<void> {
        return undefined;
    }

    public async delete(): Promise<void> {
        return undefined;
    }
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

/** Send bytes through the tunnel and wait for the fake relay's echo. */
function echoThroughTunnel(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
        socket.once('data', data => {
            socket.destroy();
            resolve(data.toString('utf8'));
        });
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('The tunnel closed without an echo.')));
    });
}

describe('DatabaseTunnelManager with service login', () => {
    let relay: FakeRelay;
    let manager: DatabaseTunnelManager;
    let config: DatabaseTunnelConfig;

    beforeEach(async () => {
        relay = new FakeRelay();
        const relayPort = await relay.start();
        manager = new DatabaseTunnelManager(new MemorySecrets() as unknown as SecretStorage);
        config = {
            id: 'service-tunnel',
            serverUrl: `http://127.0.0.1:${relayPort}/base`,
            targetId: 'netezza',
            localPort: await getFreeLocalPort(),
            auth: 'service-login',
        };
    });

    afterEach(async () => {
        await manager.stopAll();
        await relay.stop();
    });

    it('logs in, then opens the tunnel with the JWT and a client proof', async () => {
        const endpoint = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');

        expect(relay.logins).toEqual([{ username: 'analyst', password: PASSWORD }]);
        expect(endpoint.clientProof).toEqual(expect.any(String));
        expect(endpoint.clientProof!.length).toBeGreaterThanOrEqual(32);

        await expect(echoThroughTunnel(endpoint.port, 'hello')).resolves.toBe('hello');
        expect(relay.upgrades).toEqual([{
            authorization: 'Bearer jwt-1',
            proof: endpoint.clientProof,
            url: '/base/tunnel/netezza',
        }]);
    });

    it('reports a wrong password when starting, and leaves no listener', async () => {
        await expect(manager.ensureStarted(config, 'wrong', 'profile', 'analyst')).rejects.toThrow(
            'Could not start database tunnel: The service rejected the login or password.',
        );

        expect(manager.getStatuses()).toEqual([]);
        await expect(echoThroughTunnel(config.localPort, 'x')).rejects.toThrow();
    });

    it('reuses the JWT across connections and returns the same proof', async () => {
        const first = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');
        await echoThroughTunnel(first.port, 'one');
        const second = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');
        await echoThroughTunnel(second.port, 'two');

        expect(second.clientProof).toBe(first.clientProof);
        expect(relay.logins).toHaveLength(1);
        expect(relay.upgrades.map(upgrade => upgrade.authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-1']);
    });

    it('logs in again once when the server refuses a JWT, without losing bytes', async () => {
        const endpoint = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');
        relay.refuseTokens.add('jwt-1');

        await expect(echoThroughTunnel(endpoint.port, 'payload')).resolves.toBe('payload');

        expect(relay.logins).toHaveLength(2);
        expect(relay.upgrades.map(upgrade => upgrade.authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
    });

    it('gives up after one retry and closes the local connection', async () => {
        const endpoint = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');
        relay.refuseTokens.add('jwt-1');
        relay.refuseTokens.add('jwt-2');

        await expect(echoThroughTunnel(endpoint.port, 'payload')).rejects.toThrow();

        expect(relay.upgrades).toHaveLength(2);
    });

    it('lets connections opened together share one start', async () => {
        relay.loginDelayMs = 100;

        const endpoints = await Promise.all([
            manager.ensureStarted(config, PASSWORD, 'profile', 'analyst'),
            manager.ensureStarted(config, PASSWORD, 'profile', 'analyst'),
            manager.ensureStarted(config, PASSWORD, 'profile', 'analyst'),
        ]);

        expect(relay.logins).toHaveLength(1);
        expect(new Set(endpoints.map(endpoint => endpoint.clientProof)).size).toBe(1);
    });

    it('restarts with a new proof and a new login when the password or user changes', async () => {
        const first = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');
        const second = await manager.ensureStarted(config, PASSWORD, 'profile', 'other-user');

        expect(second.clientProof).not.toBe(first.clientProof);
        expect(relay.logins.map(login => login.username)).toEqual(['analyst', 'other-user']);
    });

    it('requires a service login name', async () => {
        await expect(manager.ensureStarted(config, PASSWORD, 'profile')).rejects.toThrow(
            'A service login is required',
        );
    });

    it('keeps secrets out of tunnel status', async () => {
        const endpoint = await manager.ensureStarted(config, PASSWORD, 'profile', 'analyst');

        const status = JSON.stringify(manager.getStatuses());

        expect(status).not.toContain(PASSWORD);
        expect(status).not.toContain('jwt-');
        expect(status).not.toContain(endpoint.clientProof);
    });

    it('sends no client proof and makes no login in bearer token mode', async () => {
        const bearerConfig = { ...config, auth: undefined };

        const endpoint = await manager.ensureStarted(bearerConfig, 'static-token', 'profile');
        await echoThroughTunnel(endpoint.port, 'bearer');

        expect(endpoint).toEqual({ host: '127.0.0.1', port: config.localPort });
        expect(relay.logins).toEqual([]);
        expect(relay.upgrades).toEqual([{
            authorization: 'Bearer static-token',
            proof: undefined,
            url: '/base/tunnel/netezza',
        }]);
    });
});

describe('database tunnel secret rules', () => {
    const bearer: DatabaseTunnelConfig = {
        id: 'a',
        serverUrl: 'https://relay.example.test',
        targetId: 'netezza',
        localPort: 15480,
    };
    const service: DatabaseTunnelConfig = { ...bearer, auth: 'service-login' };

    it('treats a changed sign-in mode like a changed relay, so a secret is never reused', () => {
        expect(isDatabaseTunnelRelayChanged(bearer, service)).toBe(true);
        expect(isDatabaseTunnelRelayChanged(service, bearer)).toBe(true);
        expect(isDatabaseTunnelRelayChanged(service, service)).toBe(false);
    });

    it('names the right secret in its messages', () => {
        expect(databaseTunnelSecretChangeMessage(bearer, service)).toBe(
            'A new service password is required when the database tunnel sign-in mode changes.',
        );
        expect(databaseTunnelSecretChangeMessage(bearer, bearer)).toBe(
            'A new bearer token is required when the database tunnel relay URL changes.',
        );
    });
});
