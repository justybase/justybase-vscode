import { createRequire } from 'node:module';
import * as net from 'node:net';
import type { SecretStorage } from 'vscode';

const _extensionRequire = createRequire(__filename);

const TUNNEL_PROFILES_STATE_KEY = 'justybase.postgresql.tunnelProfiles.v1';
const TUNNEL_SECRET_PREFIX = 'justybase.postgresql.tunnel.token.';
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

interface StateStore {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

export type TunnelState = 'stopped' | 'listening' | 'error';

export interface PostgreSqlTunnelProfile {
    id: string;
    name: string;
    serverUrl: string;
    targetId: string;
    localPort: number;
}

export interface PostgreSqlTunnelStatus extends PostgreSqlTunnelProfile {
    host: string;
    state: TunnelState;
    activeConnections: number;
    error?: string;
}

type TunnelProfileRecord = PostgreSqlTunnelProfile;

interface ActiveTunnel {
    profile: TunnelProfileRecord;
    server: net.Server;
    token: string;
    state: TunnelState;
    activeConnections: Set<RelayConnection>;
    listenPromise?: Promise<void>;
    closePromise?: Promise<void>;
    stopRequested: boolean;
    error?: string;
}

interface RelayConnection {
    close(): void;
}

function getWebSocketConstructor(): WebSocketConstructor {
    return _extensionRequire('ws') as WebSocketConstructor;
}

function normalizeServerUrl(value: string): string {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error('Tunnel server URL must use http(s) or ws(s).');
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

function normalizeProfile(profile: PostgreSqlTunnelProfile): TunnelProfileRecord {
    const id = profile.id.trim();
    const name = profile.name.trim();
    const serverUrl = normalizeServerUrl(profile.serverUrl);
    const targetId = profile.targetId.trim();
    const localPort = Math.floor(profile.localPort);

    if (!id) throw new Error('Tunnel profile id is required.');
    if (!name) throw new Error('Tunnel profile name is required.');
    if (!targetId) throw new Error('Tunnel target id is required.');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        throw new Error('Tunnel local port must be an integer between 1 and 65535.');
    }

    return { id, name, serverUrl, targetId, localPort };
}

function normalizeIncomingProfile(value: unknown): TunnelProfileRecord | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<PostgreSqlTunnelProfile>;
    if (
        typeof candidate.id !== 'string'
        || typeof candidate.name !== 'string'
        || typeof candidate.serverUrl !== 'string'
        || typeof candidate.targetId !== 'string'
        || typeof candidate.localPort !== 'number'
    ) return undefined;

    try {
        return normalizeProfile(candidate as PostgreSqlTunnelProfile);
    } catch {
        return undefined;
    }
}

function toBuffer(data: WebSocketMessageData): Buffer {
    if (typeof data === 'string') throw new Error('Tunnel accepts binary WebSocket frames only.');
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.concat(data.map(item => Buffer.from(item)));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A local TCP-to-WebSocket relay. Each local PostgreSQL socket gets its own
 * WebSocket, so PostgreSQL framing, cancellation and TLS all pass through
 * unchanged and never need to be interpreted by the tunnel.
 */
export class PostgreSqlTunnelManager {
    private readonly _active = new Map<string, ActiveTunnel>();
    private readonly _logger: (message: string, error?: unknown) => void;

    public constructor(
        private readonly _state: StateStore,
        private readonly _secrets: SecretStorage,
        logger: (message: string, error?: unknown) => void = () => undefined,
    ) {
        this._logger = logger;
    }

    public async listProfiles(): Promise<PostgreSqlTunnelProfile[]> {
        const stored = this._state.get<unknown[]>(TUNNEL_PROFILES_STATE_KEY, []) ?? [];
        return stored
            .map(normalizeIncomingProfile)
            .filter((profile): profile is TunnelProfileRecord => profile !== undefined)
            .map(profile => ({ ...profile }));
    }

    public async saveProfile(profile: PostgreSqlTunnelProfile, token?: string): Promise<PostgreSqlTunnelProfile> {
        const normalized = normalizeProfile(profile);
        const existing = await this.listProfiles();
        const existingToken = await this.getToken(normalized.id);
        const nextToken = token?.trim() || existingToken;
        if (!nextToken) throw new Error('Tunnel token is required.');
        const profiles = [...existing.filter(item => item.id !== normalized.id), normalized];
        await this._state.update(TUNNEL_PROFILES_STATE_KEY, profiles);
        await this._secrets.store(this.getSecretKey(normalized.id), nextToken);
        return { ...normalized };
    }

    public async deleteProfile(id: string): Promise<void> {
        const normalizedId = id.trim();
        const profiles = await this.listProfiles();
        if (this._active.has(normalizedId)) await this.stop(normalizedId);
        await this._state.update(TUNNEL_PROFILES_STATE_KEY, profiles.filter(profile => profile.id !== normalizedId));
        await this._secrets.delete(this.getSecretKey(normalizedId));
    }

    public async getToken(id: string): Promise<string | undefined> {
        return await this._secrets.get(this.getSecretKey(id.trim()));
    }

    public async start(id: string): Promise<PostgreSqlTunnelStatus> {
        const profile = (await this.listProfiles()).find(item => item.id === id.trim());
        if (!profile) throw new Error(`Tunnel profile '${id}' was not found.`);
        const token = await this.getToken(profile.id);
        if (!token) throw new Error(`No token is configured for tunnel profile '${profile.name}'.`);
        return await this.startWithToken(profile, token);
    }

    public async startWithToken(profile: PostgreSqlTunnelProfile, token: string): Promise<PostgreSqlTunnelStatus> {
        const normalized = normalizeProfile(profile);
        if (!token.trim()) throw new Error('Tunnel token is required.');
        if (this._active.has(normalized.id)) await this.stop(normalized.id);

        const active: ActiveTunnel = {
            profile: normalized,
            server: net.createServer(socket => {
                void this.openRelay(active, socket);
            }),
            token: token.trim(),
            state: 'stopped',
            activeConnections: new Set(),
            stopRequested: false,
        };
        this._active.set(normalized.id, active);

        try {
            active.listenPromise = new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    active.server.removeListener('listening', onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    active.server.removeListener('error', onError);
                    active.server.on('error', error => {
                        active.state = 'error';
                        active.error = errorMessage(error);
                        this._logger('PostgreSQL tunnel server error.', error);
                    });
                    resolve();
                };
                active.server.once('error', onError);
                active.server.once('listening', onListening);
                active.server.listen(normalized.localPort, LOOPBACK_HOST);
            });
            await active.listenPromise;
            if (active.stopRequested) {
                throw new Error('PostgreSQL tunnel was stopped while it was starting.');
            }
            active.state = 'listening';
            return this.toStatus(active);
        } catch (error: unknown) {
            active.state = 'error';
            active.error = errorMessage(error);
            if (this._active.get(normalized.id) === active) this._active.delete(normalized.id);
            await this.closeServer(active);
            throw new Error(`Could not start PostgreSQL tunnel: ${active.error}`, { cause: error });
        }
    }

    public async stop(id: string): Promise<void> {
        const active = this._active.get(id.trim());
        if (!active) return;
        this._active.delete(active.profile.id);
        active.stopRequested = true;
        for (const connection of active.activeConnections) connection.close();
        active.activeConnections.clear();
        await this.closeServer(active);
        active.state = 'stopped';
    }

    public async stopAll(): Promise<void> {
        await Promise.all([...this._active.keys()].map(id => this.stop(id)));
    }

    public getStatuses(): PostgreSqlTunnelStatus[] {
        return [...this._active.values()].map(active => this.toStatus(active));
    }

    public getSecretKey(id: string): string {
        return `${TUNNEL_SECRET_PREFIX}${id}`;
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
            if (reason) this._logger(`PostgreSQL tunnel connection closed: ${errorMessage(reason)}`);
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
            websocket = new WebSocket(buildTunnelUrl(active.profile.serverUrl, active.profile.targetId), {
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
                    finish(new Error('Tunnel accepts binary WebSocket frames only.'));
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

    private toStatus(active: ActiveTunnel): PostgreSqlTunnelStatus {
        return {
            ...active.profile,
            host: LOOPBACK_HOST,
            state: active.state,
            activeConnections: active.activeConnections.size,
            ...(active.error ? { error: active.error } : {}),
        };
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
                return;
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

export const postgresqlTunnelDefaults = {
    localHost: LOOPBACK_HOST,
    localPort: DEFAULT_LOCAL_PORT,
} as const;

export const postgresqlTunnelStateKey = TUNNEL_PROFILES_STATE_KEY;
