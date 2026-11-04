import * as http from 'node:http';
import * as https from 'node:https';

const LOGIN_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REFRESH_MARGIN_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface ServiceLoginResponse {
    status: number;
    body: string;
}

/** Posts JSON and returns the raw response. Implementations must not follow redirects. */
export type ServiceLoginTransport = (url: URL, body: string) => Promise<ServiceLoginResponse>;

/**
 * Service credentials travel to this URL, so it must be protected by TLS.
 * Plain HTTP is accepted only on loopback, for local development.
 */
export function assertServiceLoginUrl(serverUrl: string): void {
    const parsed = new URL(serverUrl);
    if (parsed.username || parsed.password) {
        throw new Error('The service URL must not contain a login or password.');
    }
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    if (!secure && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
        throw new Error('Service login requires an HTTPS URL. Plain HTTP is allowed only on localhost.');
    }
}

function buildLoginUrl(serverUrl: string): URL {
    const parsed = new URL(serverUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/auth/token`;
    return parsed;
}

const nodeTransport: ServiceLoginTransport = (url, body) => new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Accept: 'application/json',
        },
        timeout: LOGIN_TIMEOUT_MS,
    }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
                request.destroy(new Error('The service login response is too large.'));
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
        }));
        response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('The service login timed out.')));
    request.on('error', reject);
    request.end(body);
});

interface CachedToken {
    value: string;
    refreshAtMs: number;
}

function parseLoginResponse(body: string): { token: string; expiresInSeconds: number } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('The service returned an invalid login response.');
    }
    const fields = (parsed ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (
        typeof fields.access_token !== 'string'
        || fields.access_token.length === 0
        || typeof fields.expires_in !== 'number'
        || !(fields.expires_in > 0)
    ) {
        throw new Error('The service returned an invalid login response.');
    }
    return { token: fields.access_token, expiresInSeconds: fields.expires_in };
}

/**
 * Logs in to the service and keeps the JWT in memory only. Each new database
 * connection asks for a token; a login is made only when none is still valid.
 */
export class TunnelServiceLogin {
    private cached: CachedToken | undefined;
    private pending: Promise<string> | undefined;
    private readonly loginUrl: URL;

    public constructor(
        serverUrl: string,
        private readonly username: string,
        private readonly password: string,
        private readonly transport: ServiceLoginTransport = nodeTransport,
        private readonly now: () => number = Date.now,
    ) {
        assertServiceLoginUrl(serverUrl);
        this.loginUrl = buildLoginUrl(serverUrl);
    }

    public async getToken(): Promise<string> {
        if (this.cached && this.now() < this.cached.refreshAtMs) {
            return this.cached.value;
        }
        this.pending ??= this.login().finally(() => {
            this.pending = undefined;
        });
        return await this.pending;
    }

    /** Forget a token the server refused. A newer token is left in place. */
    public invalidate(token: string): void {
        if (this.cached?.value === token) {
            this.cached = undefined;
        }
    }

    private async login(): Promise<string> {
        const response = await this.transport(
            this.loginUrl,
            JSON.stringify({ username: this.username, password: this.password }),
        );
        if (response.status === 401 || response.status === 403) {
            throw new Error('The service rejected the login or password.');
        }
        if (response.status < 200 || response.status >= 300) {
            // The response body is not included: it may echo the request.
            throw new Error(`The service login failed with HTTP ${response.status}.`);
        }

        const { token, expiresInSeconds } = parseLoginResponse(response.body);
        const marginSeconds = Math.min(REFRESH_MARGIN_SECONDS, expiresInSeconds / 2);
        this.cached = {
            value: token,
            refreshAtMs: this.now() + (expiresInSeconds - marginSeconds) * 1000,
        };
        return token;
    }
}
