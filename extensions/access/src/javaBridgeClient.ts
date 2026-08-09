import { spawn, type ChildProcess } from 'child_process';
import * as readline from 'readline';

export interface BridgeColumnDefinition {
    name: string;
    type: string;
    jdbcType?: number;
    precision?: number;
    scale?: number;
}

export interface BridgeQueryResponse {
    kind: 'query' | 'update';
    columns: BridgeColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
    cancelled: boolean;
    cursorId?: number;
    hasMore?: boolean;
}

export interface BridgeFetchResponse {
    kind: 'fetch';
    rows: unknown[][];
    hasMore: boolean;
    cancelled: boolean;
}

export interface BridgeMetadataResponse {
    kind: 'metadata';
    columns: BridgeColumnDefinition[];
    rows: unknown[][];
}

export interface BridgeMetadataParams {
    table?: string;
    serverSide?: boolean;
}

export interface PendingQuery {
    requestId: number;
    result: Promise<BridgeQueryResponse>;
}

interface BridgeEnvelope {
    id: number;
    ok: boolean;
    error?: string;
    kind?: 'query' | 'update' | 'fetch' | 'metadata';
    columns?: BridgeColumnDefinition[];
    rows?: unknown[][];
    recordsAffected?: number;
    cancelled?: boolean;
    cursorId?: number;
    hasMore?: boolean;
}

interface PendingEntry {
    resolve: (value: BridgeEnvelope) => void;
    reject: (reason: Error) => void;
}

export interface JavaBridgeClientOptions {
    javaExecutable: string;
    bridgeJarPath: string;
}

const CONNECT_TIMEOUT_MS = 60_000;

export class JavaBridgeClient {
    private _process?: ChildProcess;
    private _stdinOpen = false;
    private _closed = false;
    private readonly _pending = new Map<number, PendingEntry>();
    private _nextRequestId = 1;

    public constructor(private readonly _options: JavaBridgeClientOptions) {}

    public get running(): boolean {
        return this._stdinOpen && !this._closed;
    }

    public async start(): Promise<void> {
        if (this._process && this._stdinOpen) {
            return;
        }

        const processHandle = spawn(this._options.javaExecutable, ['-jar', this._options.bridgeJarPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
        });

        this._process = processHandle;
        this._stdinOpen = true;

        const reader = readline.createInterface({
            input: processHandle.stdout,
            crlfDelay: Infinity,
        });

        processHandle.stderr.on('data', (chunk: Buffer) => {
            const line = chunk.toString().trim();
            if (line.length > 0) {
                console.warn(`[access-bridge] ${line}`);
            }
        });

        reader.on('line', (line) => {
            this._handleLine(line);
        });

        const onProcessExit = (code: number | null, signal: string | null) => {
            this._stdinOpen = false;
            const reason = new Error(
                `Java bridge process exited unexpectedly${code !== null ? ` (code ${code})` : ` (${signal})`}. ` +
                'Check the Java installation and that resources/access-bridge.jar is present.',
            );
            this._rejectAllPending(reason);
        };

        const onProcessError = (error: Error) => {
            this._stdinOpen = false;
            const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? `Java executable '${this._options.javaExecutable}' was not found. Install Java 11+ or set 'justybase.access.javaPath'.`
                : `Failed to launch Java bridge: ${error.message}`;
            this._rejectAllPending(new Error(detail));
        };

        processHandle.once('exit', onProcessExit);
        processHandle.once('error', onProcessError);
        this._process = processHandle;

        try {
            await this.ping();
        } catch (error) {
            this._cleanupProcess();
            throw error;
        }
    }

    public async connect(
        databasePath: string,
        options: { readOnly?: boolean; password?: string } = {},
    ): Promise<void> {
        const pending = this._request('connect', {
            path: databasePath,
            readOnly: options.readOnly !== false,
            ...(options.password ? { password: options.password } : {}),
        });
        await this._awaitRequest(pending, CONNECT_TIMEOUT_MS);
    }

    public query(sql: string, params?: readonly unknown[], chunkSize?: number): PendingQuery {
        const requestId = this._nextRequestId++;
        const promise = new Promise<BridgeQueryResponse>((resolve, reject) => {
            this._pending.set(requestId, {
                resolve: (envelope) => {
                    if (!envelope.ok) {
                        reject(new Error(envelope.error ?? 'Access bridge reported an error.'));
                        return;
                    }
                    resolve(this._toQueryResponse(envelope));
                },
                reject,
            });
        });

        this._send({
            id: requestId,
            op: 'query',
            sql,
            params: params && params.length > 0 ? [...params] : undefined,
            chunkSize: chunkSize ?? undefined,
        });

        return { requestId, result: promise };
    }

    public async fetchMore(cursorId: number, chunkSize?: number): Promise<BridgeFetchResponse> {
        const pending = this._request('fetchMore', {
            cursorId,
            chunkSize: chunkSize ?? undefined,
        });
        const envelope = await this._awaitRequest(pending);
        if (envelope.kind !== 'fetch') {
            throw new Error('Unexpected response from the Access bridge.');
        }
        return {
            kind: 'fetch',
            rows: envelope.rows ?? [],
            hasMore: envelope.hasMore === true,
            cancelled: envelope.cancelled === true,
        };
    }

    public async closeCursor(cursorId: number): Promise<void> {
        const pending = this._request('closeCursor', { cursorId });
        await this._awaitRequest(pending);
    }

    public async cancel(queryId: number): Promise<void> {
        const pending = this._request('cancel', { queryId });
        await this._awaitRequest(pending);
    }

    public async metadata(kind: string, params: BridgeMetadataParams = {}): Promise<BridgeMetadataResponse> {
        const pending = this._request('metadata', {
            kind,
            table: params.table ?? undefined,
            serverSide: params.serverSide === true,
        });
        const envelope = await this._awaitRequest(pending);
        return {
            kind: 'metadata',
            columns: envelope.columns ?? [],
            rows: envelope.rows ?? [],
        };
    }

    public async ping(): Promise<void> {
        const pending = this._request('ping');
        await this._awaitRequest(pending, 10_000);
    }

    public async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;

        if (this._stdinOpen) {
            try {
                const pending = this._request('close');
                await this._awaitRequest(pending, 10_000);
            } catch {
                // The process may already be gone; cleanup below.
            }
        }

        this._cleanupProcess();
    }

    private _request(op: string, payload: Record<string, unknown> = {}): Promise<BridgeEnvelope> {
        const requestId = this._nextRequestId++;
        const promise = new Promise<BridgeEnvelope>((resolve, reject) => {
            this._pending.set(requestId, { resolve, reject });
        });
        this._send({ id: requestId, op, ...payload });
        return promise;
    }

    private _send(payload: Record<string, unknown>): void {
        if (!this._stdinOpen || !this._process) {
            throw new Error('Java bridge process is not running.');
        }
        const stdin = this._process.stdin;
        if (!stdin) {
            throw new Error('Java bridge process stdin is not available.');
        }
        stdin.write(`${JSON.stringify(payload)}\n`);
    }

    private async _awaitRequest(promise: Promise<BridgeEnvelope>, timeoutMs?: number): Promise<BridgeEnvelope> {
        let result: BridgeEnvelope;
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Timed out waiting for the Access bridge.')), timeoutMs);
            });
            try {
                result = await Promise.race([promise, timeout]);
            } finally {
                if (timer) {
                    clearTimeout(timer);
                }
            }
        } else {
            result = await promise;
        }

        if (!result.ok) {
            throw new Error(result.error ?? 'Access bridge reported an error.');
        }
        return result;
    }

    private _handleLine(line: string): void {
        let envelope: BridgeEnvelope;
        try {
            envelope = JSON.parse(line) as BridgeEnvelope;
        } catch {
            console.warn(`[access-bridge] Ignoring malformed response: ${line.slice(0, 200)}`);
            return;
        }

        if (typeof envelope.id !== 'number') {
            return;
        }

        const pending = this._pending.get(envelope.id);
        if (!pending) {
            return;
        }

        this._pending.delete(envelope.id);
        pending.resolve(envelope);
    }

    private _toQueryResponse(envelope: BridgeEnvelope): BridgeQueryResponse {
        if (envelope.kind !== 'query' && envelope.kind !== 'update') {
            throw new Error('Unexpected response from the Access bridge.');
        }

        if (envelope.kind === 'update') {
            return {
                kind: 'update',
                columns: [],
                rows: [],
                recordsAffected: envelope.recordsAffected ?? -1,
                cancelled: false,
            };
        }

        return {
            kind: 'query',
            columns: envelope.columns ?? [],
            rows: envelope.rows ?? [],
            recordsAffected: envelope.recordsAffected ?? -1,
            cancelled: envelope.cancelled === true,
            cursorId: envelope.cursorId,
            hasMore: envelope.hasMore === true,
        };
    }

    private _rejectAllPending(reason: Error): void {
        for (const [id, pending] of this._pending) {
            this._pending.delete(id);
            pending.reject(reason);
        }
    }

    private _cleanupProcess(): void {
        this._stdinOpen = false;
        const processHandle = this._process;
        this._process = undefined;
        if (processHandle) {
            try {
                processHandle.kill();
            } catch {
                // Process already terminated.
            }
        }
        this._rejectAllPending(new Error('Java bridge process was closed.'));
    }
}
