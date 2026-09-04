import * as net from 'node:net';
import type { SecretStorage } from 'vscode';
import type { DatabaseTunnelConfig } from '../contracts/database';

const TUNNEL_SECRET_PREFIX = 'justybase.database.tunnel.token.';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LOCAL_PORT = 15432;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const QUEUE_RESUME_BYTES = 1024 * 1024;
const WS_OPEN = 1;

type WebSocketMessageData = string | Buffer | ArrayBuffer | readonly Buffer[];

interface WebSocketLike {
    readonly readyState: number;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: WebSocketMessageData, isBinary: boolean) => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
    on(event: 'close', listener: () => void): this;
    send(data: Buffer, callback?: (error?: Error) => void): void;
    pause(): void;
    resume(): void;
    terminate(): void;
    ping(): void;
}

interface WebSocketConstructor {
    new (url: string, options: { headers: { Authorization: string }; handshakeTimeout: number }): WebSocketLike;
}

// Keep this as a literal CommonJS require so esbuild includes ws in the core
// VSIX even though the package is built with --no-dependencies.
const WebSocket = require('ws') as WebSocketConstructor;

interface RelayConnection {
    close(): void;
}

interface ActiveTunnel {
    config: DatabaseTunnelConfig;
    connectionName?: string;
    server: net.Server;
    token: string;
    state: DatabaseTunnelState;
    activeConnections: Set<RelayConnection>;
    listenPromise?: Promise<void>;
    closePromise?: Promise<void>;
    stopRequested: boolean;
    error?: string;
}

export type DatabaseTunnelState = 'stopped' | 'listening' | 'error';

export interface DatabaseTunnelStatus extends DatabaseTunnelConfig {
    host: string;
    state: DatabaseTunnelState;
    activeConnections: number;
    connectionName?: string;
    error?: string;
}

export interface DatabaseTunnelEndpoint {
    host: typeof LOOPBACK_HOST;
    port: number;
}

export interface DatabaseTunnelRuntime {
    ensureStarted(
        config: DatabaseTunnelConfig,
        token: string,
        connectionName?: string,
    ): Promise<DatabaseTunnelEndpoint>;
    stop(id: string): Promise<void>;
    stopAll(): Promise<void>;
    getToken(id: string): Promise<string | undefined>;
    storeToken(id: string, token: string): Promise<void>;
    deleteToken(id: string): Promise<void>;
    /** Return true only when the exact config/token pair is already listening. */
    isActive(config: DatabaseTunnelConfig, token: string): boolean;
    getStatuses(): DatabaseTunnelStatus[];
}

export const databaseTunnelDefaults = {
    localHost: LOOPBACK_HOST,
    localPort: DEFAULT_LOCAL_PORT,
} as const;

export function normalizeDatabaseTunnelConfig(config: DatabaseTunnelConfig): DatabaseTunnelConfig {
    const id = config.id.trim();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const targetId = config.targetId.trim();
    const localPort = Math.floor(config.localPort);

    if (!id) throw new Error('Database tunnel id is required.');
    if (!targetId) throw new Error('Database tunnel target id is required.');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        throw new Error('Database tunnel local port must be an integer between 1 and 65535.');
    }

    return { id, serverUrl, targetId, localPort };
}

export function sameDatabaseTunnelConfig(
    left: DatabaseTunnelConfig,
    right: DatabaseTunnelConfig,
): boolean {
    const normalizedLeft = normalizeDatabaseTunnelConfig(left);
    const normalizedRight = normalizeDatabaseTunnelConfig(right);
    return normalizedLeft.id === normalizedRight.id
        && normalizedLeft.serverUrl === normalizedRight.serverUrl
        && normalizedLeft.targetId === normalizedRight.targetId
        && normalizedLeft.localPort === normalizedRight.localPort;
}

export function isDatabaseTunnelRelayChanged(
    left: DatabaseTunnelConfig | undefined,
    right: DatabaseTunnelConfig | undefined,
): boolean {
    if (!left || !right) return false;
    return normalizeDatabaseTunnelConfig(left).serverUrl
        !== normalizeDatabaseTunnelConfig(right).serverUrl;
}

function getWebSocketConstructor(): WebSocketConstructor {
    return WebSocket;
}

function normalizeServerUrl(value: string): string {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error('Database tunnel server URL must use http(s) or ws(s).');
    }

    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}

function buildTunnelUrl(serverUrl: string, targetId: string): string {
    const parsed = new URL(normalizeServerUrl(serverUrl));
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/tunnel/${encodeURIComponent(targetId)}`;
    return parsed.toString();
}

function toBuffer(data: WebSocketMessageData): Buffer {
    if (typeof data === 'string') throw new Error('Database tunnel accepts binary WebSocket frames only.');
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.concat(data.map(item => Buffer.from(item)));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Transparent TCP-to-WebSocket relay for network database drivers.
 * PostgreSQL, Netezza, Oracle and their TLS handshakes are forwarded without
 * being parsed by the client-side tunnel.
 */
export class DatabaseTunnelManager implements DatabaseTunnelRuntime {
    private readonly active = new Map<string, ActiveTunnel>();
    private readonly logger: (message: string, error?: unknown) => void;

    public constructor(
        private readonly secrets: SecretStorage,
        logger: (message: string, error?: unknown) => void = () => undefined,
    ) {
        this.logger = logger;
    }

    public async ensureStarted(
        config: DatabaseTunnelConfig,
        token: string,
        connectionName?: string,
    ): Promise<DatabaseTunnelEndpoint> {
        const normalized = normalizeDatabaseTunnelConfig(config);
        const trimmedToken = token.trim();
        if (!trimmedToken) throw new Error('Database tunnel token is required.');

        const existing = this.active.get(normalized.id);
        if (
            existing
            && !existing.stopRequested
            && sameDatabaseTunnelConfig(existing.config, normalized)
            && existing.token === trimmedToken
            && existing.state === 'listening'
        ) {
            existing.connectionName = connectionName ?? existing.connectionName;
            return { host: LOOPBACK_HOST, port: normalized.localPort };
        }
        if (existing) await this.stop(normalized.id);

        const active: ActiveTunnel = {
            config: normalized,
            connectionName,
            server: net.createServer(socket => {
                void this.openRelay(active, socket);
            }),
            token: trimmedToken,
            state: 'stopped',
            activeConnections: new Set(),
            stopRequested: false,
        };
        this.active.set(normalized.id, active);

        try {
            active.listenPromise = this.listen(active);
            await active.listenPromise;
            if (active.stopRequested) {
                throw new Error('Database tunnel was stopped while it was starting.');
            }
            active.state = 'listening';
            return { host: LOOPBACK_HOST, port: normalized.localPort };
        } catch (error: unknown) {
            active.state = 'error';
            active.error = errorMessage(error);
            if (this.active.get(normalized.id) === active) this.active.delete(normalized.id);
            await this.closeServer(active);
            throw new Error(`Could not start database tunnel: ${active.error}`, { cause: error });
        }
    }

    public async stop(id: string): Promise<void> {
        const normalizedId = id.trim();
        const active = this.active.get(normalizedId);
        if (!active) return;

        this.active.delete(normalizedId);
        active.stopRequested = true;
        for (const connection of active.activeConnections) connection.close();
        active.activeConnections.clear();
        await this.closeServer(active);
        active.state = 'stopped';
    }

    public async stopAll(): Promise<void> {
        await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    }

    public async getToken(id: string): Promise<string | undefined> {
        return await this.secrets.get(this.getSecretKey(id));
    }

    public async storeToken(id: string, token: string): Promise<void> {
        const trimmed = token.trim();
        if (!trimmed) throw new Error('Database tunnel token is required.');
        await this.secrets.store(this.getSecretKey(id), trimmed);
    }

    public async deleteToken(id: string): Promise<void> {
        await this.secrets.delete(this.getSecretKey(id));
    }

    public isActive(config: DatabaseTunnelConfig, token: string): boolean {
        const normalized = normalizeDatabaseTunnelConfig(config);
        const active = this.active.get(normalized.id);
        return Boolean(
            active
            && !active.stopRequested
            && active.state === 'listening'
            && active.token === token.trim()
            && sameDatabaseTunnelConfig(active.config, normalized),
        );
    }

    public getStatuses(): DatabaseTunnelStatus[] {
        return [...this.active.values()].map(active => ({
            ...active.config,
            host: LOOPBACK_HOST,
            state: active.state,
            activeConnections: active.activeConnections.size,
            ...(active.connectionName ? { connectionName: active.connectionName } : {}),
            ...(active.error ? { error: active.error } : {}),
        }));
    }

    public getSecretKey(id: string): string {
        return `${TUNNEL_SECRET_PREFIX}${id.trim()}`;
    }

    private listen(active: ActiveTunnel): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                active.server.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = (): void => {
                active.server.removeListener('error', onError);
                active.server.on('error', error => {
                    active.state = 'error';
                    active.error = errorMessage(error);
                    this.logger('Database tunnel server error.', error);
                });
                resolve();
            };
            active.server.once('error', onError);
            active.server.once('listening', onListening);
            active.server.listen(active.config.localPort, LOOPBACK_HOST);
        });
    }

    private async openRelay(active: ActiveTunnel, socket: net.Socket): Promise<void> {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        socket.pause();

        let websocket: WebSocketLike | undefined;
        let closed = false;
        const socketQueue: Buffer[] = [];
        let socketQueueBytes = 0;
        const websocketQueue: Buffer[] = [];
        let websocketQueueBytes = 0;
        let socketPumpRunning = false;
        let websocketPumpRunning = false;
        let websocketPaused = false;
        let pingTimer: NodeJS.Timeout | undefined;

        const relay: RelayConnection = {
            close: () => {
                if (closed) return;
                closed = true;
                if (pingTimer) clearInterval(pingTimer);
                socket.destroy();
                websocket?.terminate();
                active.activeConnections.delete(relay);
            },
        };
        active.activeConnections.add(relay);

        const finish = (reason?: unknown): void => {
            if (closed) return;
            if (reason) this.logger(`Database tunnel connection closed: ${errorMessage(reason)}`);
            relay.close();
        };

        const pauseWebsocket = (): void => {
            if (websocketPaused || !websocket || websocket.readyState !== WS_OPEN) return;
            websocket.pause();
            websocketPaused = true;
        };

        const resumeWebsocket = (): void => {
            if (!websocketPaused || !websocket || websocket.readyState !== WS_OPEN) return;
            websocketPaused = false;
            websocket.resume();
        };

        const pumpSocketQueue = (): void => {
            if (closed || !websocket || websocket.readyState !== WS_OPEN || socketPumpRunning) return;
            const next = socketQueue.shift();
            if (!next) {
                if (socket.isPaused()) socket.resume();
                return;
            }
            socketQueueBytes -= next.length;
            socketPumpRunning = true;
            websocket.send(next, (error?: Error) => {
                socketPumpRunning = false;
                if (error) {
                    finish(error);
                    return;
                }
                if (socketQueueBytes < QUEUE_RESUME_BYTES && socket.isPaused()) socket.resume();
                pumpSocketQueue();
            });
        };

        const pumpWebsocketQueue = (): void => {
            if (closed || websocketPumpRunning) return;
            const next = websocketQueue.shift();
            if (!next) {
                resumeWebsocket();
                return;
            }
            websocketQueueBytes -= next.length;
            websocketPumpRunning = true;
            if (!socket.write(next)) {
                pauseWebsocket();
                socket.once('drain', () => {
                    websocketPumpRunning = false;
                    pumpWebsocketQueue();
                });
            } else {
                websocketPumpRunning = false;
                pumpWebsocketQueue();
            }
        };

        socket.on('data', (chunk: Buffer) => {
            if (closed) return;
            // A WebSocket send is asynchronous. Stop the local stream before
            // queueing the chunk so a large result cannot keep filling this
            // process while the relay is slower than the database client.
            socket.pause();
            socketQueue.push(chunk);
            socketQueueBytes += chunk.length;
            if (socketQueueBytes > MAX_QUEUE_BYTES) {
                finish(new Error('Local-to-tunnel buffer limit exceeded.'));
                return;
            }
            pumpSocketQueue();
        });
        socket.on('error', error => finish(error));
        socket.on('close', () => finish());
        socket.on('end', () => finish());

        try {
            const WebSocket = getWebSocketConstructor();
            websocket = new WebSocket(buildTunnelUrl(active.config.serverUrl, active.config.targetId), {
                headers: { Authorization: `Bearer ${active.token}` },
                handshakeTimeout: 15_000,
            });
            websocket.on('open', () => {
                if (closed) return;
                pingTimer = setInterval(() => {
                    if (websocket?.readyState === WS_OPEN) websocket.ping();
                }, 30_000);
                socket.resume();
                pumpSocketQueue();
            });
            websocket.on('message', (data, isBinary) => {
                if (closed) return;
                if (!isBinary) {
                    finish(new Error('Database tunnel accepts binary WebSocket frames only.'));
                    return;
                }
                let buffer: Buffer;
                try {
                    buffer = toBuffer(data);
                } catch (error: unknown) {
                    finish(error);
                    return;
                }
                websocketQueue.push(buffer);
                websocketQueueBytes += buffer.length;
                if (websocketQueueBytes > MAX_QUEUE_BYTES) {
                    finish(new Error('Tunnel-to-local buffer limit exceeded.'));
                    return;
                }
                pumpWebsocketQueue();
            });
            websocket.on('error', error => finish(error));
            websocket.on('close', () => finish());
        } catch (error: unknown) {
            finish(error);
        }
    }

    private async closeServer(active: ActiveTunnel): Promise<void> {
        if (active.closePromise) {
            await active.closePromise;
            return;
        }

        active.closePromise = this.finishClosingServer(active);
        await active.closePromise;
    }

    private async finishClosingServer(active: ActiveTunnel): Promise<void> {
        if (active.listenPromise && !active.server.listening) {
            try {
                await active.listenPromise;
            } catch {
                // The listener may have failed before it became active.
            }
        }
        if (!active.server.listening) return;

        await new Promise<void>((resolve, reject) => {
            try {
                active.server.close(error => {
                    if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
                        resolve();
                    } else {
                        reject(error);
                    }
                });
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
                else reject(error);
            }
        });
    }
}
