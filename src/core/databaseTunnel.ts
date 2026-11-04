import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import type { SecretStorage } from 'vscode';
import type { DatabaseTunnelConfig } from '../contracts/database';
import { assertServiceLoginUrl, TunnelServiceLogin } from './tunnelServiceLogin';

const TUNNEL_SECRET_PREFIX = 'justybase.database.tunnel.token.';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_LOCAL_PORT = 15432;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const QUEUE_RESUME_BYTES = 1024 * 1024;
const WS_OPEN = 1;
const CLIENT_PROOF_HEADER = 'X-JustyBase-Client-Proof';
const CLIENT_PROOF_BYTES = 32;
const UPGRADE_REFUSED_PATTERN = /Unexpected server response: 40[13]\b/;

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
    new (url: string, options: { headers: Record<string, string>; handshakeTimeout: number }): WebSocketLike;
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
    startPromise?: Promise<void>;
    closePromise?: Promise<void>;
    stopRequested: boolean;
    error?: string;
    /** Present only with service login. The JWT stays inside, in memory. */
    serviceLogin?: TunnelServiceLogin;
    serviceLoginUser?: string;
    /** Per-tunnel nonce the local driver must show to the relay. */
    clientProof?: string;
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
    /** Sent by the driver as its password when the relay supplies the database login. */
    clientProof?: string;
}

export interface DatabaseTunnelRuntime {
    ensureStarted(
        config: DatabaseTunnelConfig,
        token: string,
        connectionName?: string,
        serviceLoginUser?: string,
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

    if (config.auth !== undefined && config.auth !== 'bearer-token' && config.auth !== 'service-login') {
        throw new Error('Database tunnel sign-in mode is not supported.');
    }
    if (config.auth === 'service-login') {
        assertServiceLoginUrl(serverUrl);
        return { id, serverUrl, targetId, localPort, auth: 'service-login' };
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
        && normalizedLeft.localPort === normalizedRight.localPort
        && normalizedLeft.auth === normalizedRight.auth;
}

export function isDatabaseTunnelRelayChanged(
    left: DatabaseTunnelConfig | undefined,
    right: DatabaseTunnelConfig | undefined,
): boolean {
    if (!left || !right) return false;
    const normalizedLeft = normalizeDatabaseTunnelConfig(left);
    const normalizedRight = normalizeDatabaseTunnelConfig(right);
    // A saved secret belongs to one relay and one sign-in mode. Reusing it after
    // a change could send a service password as a bearer token, or the reverse.
    return normalizedLeft.serverUrl !== normalizedRight.serverUrl
        || normalizedLeft.auth !== normalizedRight.auth;
}

/** Name of the secret this tunnel keeps in SecretStorage, for user-facing messages. */
export function describeDatabaseTunnelSecret(config: DatabaseTunnelConfig | undefined): string {
    return config?.auth === 'service-login' ? 'service password' : 'bearer token';
}

export function databaseTunnelSecretChangeMessage(
    previous: DatabaseTunnelConfig | undefined,
    next: DatabaseTunnelConfig | undefined,
): string {
    const secret = describeDatabaseTunnelSecret(next);
    return previous?.auth === next?.auth
        ? `A new ${secret} is required when the database tunnel relay URL changes.`
        : `A new ${secret} is required when the database tunnel sign-in mode changes.`;
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
 * Network database protocols and their TLS handshakes are forwarded without
 * being parsed by the client-side tunnel. Dialects opt in through
 * `supportsRawTcpTunnel`.
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
        serviceLoginUser?: string,
    ): Promise<DatabaseTunnelEndpoint> {
        const normalized = normalizeDatabaseTunnelConfig(config);
        const trimmedToken = token.trim();
        if (!trimmedToken) throw new Error('Database tunnel token is required.');
        const usesServiceLogin = normalized.auth === 'service-login';
        const loginUser = usesServiceLogin ? serviceLoginUser?.trim() : undefined;
        if (usesServiceLogin && !loginUser) {
            throw new Error('A service login is required for this database tunnel.');
        }

        const existing = this.active.get(normalized.id);
        if (
            existing
            && !existing.stopRequested
            && sameDatabaseTunnelConfig(existing.config, normalized)
            && existing.token === trimmedToken
            && existing.serviceLoginUser === loginUser
        ) {
            // Connections opened together share one start. Without this the
            // second would stop the first while it is still logging in.
            if (existing.state !== 'listening' && existing.startPromise) {
                await existing.startPromise;
            }
            if (existing.state === 'listening') {
                existing.connectionName = connectionName ?? existing.connectionName;
                return this.buildEndpoint(existing);
            }
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
            ...(loginUser
                ? {
                    serviceLogin: new TunnelServiceLogin(normalized.serverUrl, loginUser, trimmedToken),
                    serviceLoginUser: loginUser,
                    clientProof: randomBytes(CLIENT_PROOF_BYTES).toString('base64url'),
                }
                : {}),
        };
        this.active.set(normalized.id, active);

        active.startPromise = this.startListening(active);
        await active.startPromise;
        return this.buildEndpoint(active);
    }

    private buildEndpoint(active: ActiveTunnel): DatabaseTunnelEndpoint {
        return {
            host: LOOPBACK_HOST,
            port: active.config.localPort,
            ...(active.clientProof ? { clientProof: active.clientProof } : {}),
        };
    }

    private async startListening(active: ActiveTunnel): Promise<void> {
        try {
            active.listenPromise = this.listen(active);
            await active.listenPromise;
            // Log in now, so a wrong password is a clear error here rather than
            // a closed socket when the driver connects.
            await active.serviceLogin?.getToken();
            if (active.stopRequested) {
                throw new Error('Database tunnel was stopped while it was starting.');
            }
            active.state = 'listening';
        } catch (error: unknown) {
            active.state = 'error';
            active.error = errorMessage(error);
            if (this.active.get(active.config.id) === active) this.active.delete(active.config.id);
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

        const connectWebSocket = async (allowRetry: boolean): Promise<void> => {
            const token = active.serviceLogin ? await active.serviceLogin.getToken() : active.token;
            if (closed) return;

            const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
            if (active.clientProof) headers[CLIENT_PROOF_HEADER] = active.clientProof;

            const WebSocket = getWebSocketConstructor();
            const current = new WebSocket(buildTunnelUrl(active.config.serverUrl, active.config.targetId), {
                headers,
                handshakeTimeout: 15_000,
            });
            websocket = current;
            let opened = false;
            current.on('open', () => {
                if (closed) return;
                opened = true;
                pingTimer = setInterval(() => {
                    if (current.readyState === WS_OPEN) current.ping();
                }, 30_000);
                socket.resume();
                pumpSocketQueue();
            });
            current.on('message', (data, isBinary) => {
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
            current.on('error', error => {
                if (current !== websocket) return;
                // The server may have revoked a JWT that had not expired yet.
                // Log in once more. The driver has sent nothing so far, because
                // the local socket stays paused until the WebSocket opens.
                if (
                    allowRetry
                    && !opened
                    && active.serviceLogin
                    && UPGRADE_REFUSED_PATTERN.test(errorMessage(error))
                ) {
                    active.serviceLogin.invalidate(token);
                    websocket = undefined;
                    current.terminate();
                    connectWebSocket(false).catch(retryError => finish(retryError));
                    return;
                }
                finish(error);
            });
            current.on('close', () => {
                if (current === websocket) finish();
            });
        };

        connectWebSocket(true).catch(error => finish(error));
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
