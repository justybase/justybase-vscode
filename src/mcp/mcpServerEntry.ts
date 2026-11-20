import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { CatalogIntrospection } from '../core/catalogIntrospection';
import {
    allowedToolIds,
    effectiveToolTiers,
    surfaceAllowsConnectionWrites,
    surfaceAllowsDestructive,
    surfaceAllowsWrites
} from '../core/assistant/toolPolicy';
import type { ToolSurface } from '../core/assistant/toolCatalog';
import {
    envToConnectionDetails,
    MCP_ENV,
    parseMcpAiToolAccess
} from './mcpEnv';
import { createNetezzaMcpServer } from './mcpServerCore';
import { isAuthorizedHttpRequest } from './mcpHttpAuth';
import type { McpToolRuntime } from './mcpToolRegistry';

/**
 * Standalone entry point for the Netezza MCP server.
 *
 * Spawned by the VS Code extension (stdio mode for Copilot Chat, http mode
 * for external MCP clients on the local machine). Connection details — and the
 * resolved tool-access policy — are passed exclusively through environment
 * variables; nothing is read from or written to disk.
 *
 * Usage:
 *   node dist/mcp/mcpServer.js                  (stdio, default)
 *   node dist/mcp/mcpServer.js --transport http --port 37210
 */

const DEFAULT_HTTP_PORT = 37210;

interface McpServerArgs {
    transport: 'stdio' | 'http';
    port: number;
}

function parseArgs(argv: string[]): McpServerArgs {
    let transport: McpServerArgs['transport'] = 'stdio';
    let port = DEFAULT_HTTP_PORT;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--transport' && argv[index + 1]) {
            const value = argv[index + 1].toLowerCase();
            if (value === 'http' || value === 'stdio') {
                transport = value;
            }
            index++;
        } else if (arg === '--port' && argv[index + 1]) {
            const parsed = Number(argv[index + 1]);
            if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
                port = parsed;
            }
            index++;
        }
    }

    return { transport, port };
}

function createRuntime(surface: ToolSurface, connectionName: string | undefined): McpToolRuntime {
    const access = parseMcpAiToolAccess(process.env);
    return {
        connectionName,
        allowWrites: surfaceAllowsWrites(access, surface),
        allowDestructive: surfaceAllowsDestructive(access, surface),
        accessLevels: effectiveToolTiers(surface, access, connectionName),
        audit: event => {
            console.error(
                `[netezza-mcp][audit] ${event.tool} tier=${event.tier} ok=${event.ok} ` +
                `surface=${event.surface} durationMs=${event.durationMs}` +
                `${event.connectionName ? ` connection=${event.connectionName}` : ''}`,
            );
        },
    };
}

function startStdio(introspection: CatalogIntrospection, serverVersion: string, connectionName: string | undefined): void {
    const surface: ToolSurface = 'mcp';
    const runtime = createRuntime(surface, connectionName);
    const access = parseMcpAiToolAccess(process.env);
    const server = createNetezzaMcpServer(introspection, {
        serverVersion,
        runtime,
        allowedToolIds: allowedToolIds(surface, access, connectionName),
    });
    const transport = new StdioServerTransport();
    void server.connect(transport).catch((error: unknown) => {
        console.error('[netezza-mcp] stdio connect failed:', error);
        process.exit(1);
    });
}

function startHttp(
    introspection: CatalogIntrospection,
    serverVersion: string,
    port: number,
    connectionName: string | undefined,
): void {
    const surface: ToolSurface = 'mcpExternal';
    const access = parseMcpAiToolAccess(process.env);
    const runtime = createRuntime(surface, connectionName);
    const allowed = allowedToolIds(surface, access, connectionName);
    const writesEnabled = surfaceAllowsConnectionWrites(access, surface, connectionName);
    const token = process.env[MCP_ENV.TOKEN]?.trim();

    if (writesEnabled && !token) {
        console.error(
            '[netezza-mcp] Refusing to start HTTP write mode without ' + MCP_ENV.TOKEN + '.'
        );
        process.exit(1);
    }

    // The SDK binds a McpServer instance to exactly one transport, so every
    // HTTP session gets its own server instance.
    const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

    const authorized = (req: http.IncomingMessage): boolean =>
        isAuthorizedHttpRequest(req.headers, token);

    const httpServer = http.createServer(async (req, res) => {
        if (!authorized(req)) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        const sessionHeader = req.headers['mcp-session-id'];
        let entry: { transport: StreamableHTTPServerTransport; server: McpServer } | undefined =
            typeof sessionHeader === 'string' ? transports.get(sessionHeader) : undefined;

        if (!entry) {
            const sessionId = randomUUID();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId
            });
            const server = createNetezzaMcpServer(introspection, {
                serverVersion,
                runtime,
                allowedToolIds: allowed,
            });
            entry = { transport, server };
            transports.set(sessionId, entry);
            transport.onclose = () => {
                transports.delete(sessionId);
            };
            await server.connect(transport);
        }

        try {
            // The SDK requires a pre-parsed body for POST requests; pass the
            // JSON-RPC message directly (undefined for GET/DELETE).
            const parsedBody = await readJsonBody(req);
            await entry.transport.handleRequest(req, res, parsedBody);
        } catch (error: unknown) {
            console.error('[netezza-mcp] request error:', error);
            if (!res.headersSent) {
                res.writeHead(500);
            }
            res.end();
        }
    });

    httpServer.listen(port, '127.0.0.1', () => {
        console.error(`[netezza-mcp] HTTP server listening on http://127.0.0.1:${port}`);
    });

    httpServer.on('error', (error: Error) => {
        console.error('[netezza-mcp] HTTP server error:', error);
        process.exit(1);
    });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    if (req.method !== 'POST') {
        return undefined;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (body.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

function shutdown(): void {
    process.exit(0);
}

async function main(): Promise<void> {
    const details = envToConnectionDetails(process.env);
    if (!details) {
        console.error(
            `[netezza-mcp] ${MCP_ENV.HOST} is not set. The server must be started by the ` +
            'JustyBase extension with the selected connection details in the environment.'
        );
        process.exit(1);
    }

    if (details.dbType !== 'netezza') {
        console.error('[netezza-mcp] The MCP server can only be started for a Netezza connection.');
        process.exit(1);
    }

    const introspection = new CatalogIntrospection({
        getConnectionDetails: async () => details
    });
    const serverVersion = process.env[MCP_ENV.VERSION] || '1.0.0';
    const connectionName = details.name ?? process.env[MCP_ENV.CONNECTION_NAME] ?? undefined;
    const args = parseArgs(process.argv.slice(2));

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    if (args.transport === 'http') {
        startHttp(introspection, serverVersion, args.port, connectionName);
    } else {
        startStdio(introspection, serverVersion, connectionName);
    }
}

void main();
