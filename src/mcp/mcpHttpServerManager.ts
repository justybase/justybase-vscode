import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { ConnectionManager } from '../core/connectionManager';
import {
    DEFAULT_AI_TOOL_ACCESS,
    allowedToolIds,
    normalizeAiToolAccess,
    surfaceAllowsConnectionWrites,
    type AccessProfile,
    type AiToolAccessConfig,
} from '../core/assistant/toolPolicy';
import { aiToolAccessToEnv, connectionDetailsToEnv, MCP_ENV } from './mcpEnv';
import {
    getConfiguredMcpConnectionName,
    resolveSelectedMcpConnection
} from './mcpConnection';
import { MCP_SERVER_VERSION } from './mcpToolCatalog';

export interface McpHttpServerStatus {
    running: boolean;
    port?: number;
    pid?: number;
    connectionName?: string;
    access: AccessProfile;
    writesEnabled: boolean;
    /** Bearer token required for HTTP requests when writes are enabled. */
    writeToken?: string;
    lastError?: string;
}

/**
 * Spawns the Netezza MCP server in HTTP mode (127.0.0.1 only) so that other
 * MCP clients on the local machine (Cursor, Claude Desktop, ...) can connect.
 *
 * The process is a child of the extension host, so connection details —
 * including the password from the VS Code Secrets API — travel through the
 * process environment and never touch the file system. The server only runs
 * while VS Code is open; stopping the server kills the child process.
 *
 * When the resolved access profile allows writes, a per-run bearer token is
 * generated and passed to the child. The token is shown only in the Settings
 * view and is required by every HTTP request.
 */
export class McpHttpServerManager {
    private readonly didChangeStatus = new vscode.EventEmitter<McpHttpServerStatus>();
    readonly onDidChangeStatus: vscode.Event<McpHttpServerStatus> = this.didChangeStatus.event;

    private child?: ChildProcess;
    private port?: number;
    private connectionName?: string;
    private accessKey?: string;
    private token?: string;
    private lastError?: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly getSelectedConnectionName: () => string | undefined = getConfiguredMcpConnectionName,
        private readonly getAccessConfigSetting: () => AiToolAccessConfig = () => DEFAULT_AI_TOOL_ACCESS,
    ) { }

    getAccessConfig(): AiToolAccessConfig {
        return normalizeAiToolAccess(this.getAccessConfigSetting());
    }

    getStatus(): McpHttpServerStatus {
        const access = this.getAccessConfig();
        const writesEnabled = surfaceAllowsConnectionWrites(access, 'mcpExternal', this.connectionName);
        return {
            running: this.child !== undefined,
            port: this.port,
            pid: this.child?.pid,
            connectionName: this.connectionName,
            access: access.mcpExternal.access,
            writesEnabled,
            ...(writesEnabled && this.token ? { writeToken: this.token } : {}),
            lastError: this.lastError
        };
    }

    async start(port: number): Promise<McpHttpServerStatus> {
        const resolution = await resolveSelectedMcpConnection(
            this.connectionManager,
            this.getSelectedConnectionName()
        );
        if ('error' in resolution) {
            if (this.child) {
                await this.stop();
            }
            this.lastError = resolution.error;
            this.didChangeStatus.fire(this.getStatus());
            return this.getStatus();
        }

        const access = this.getAccessConfig();
        const accessKey = JSON.stringify(access);
        if (allowedToolIds('mcpExternal', access, resolution.connectionName).length === 0) {
            if (this.child) {
                await this.stop();
            }
            this.lastError = 'No AI tools are enabled for the MCP HTTP surface in JustyBase AI Tools settings.';
            this.didChangeStatus.fire(this.getStatus());
            return this.getStatus();
        }
        const writesEnabled = surfaceAllowsConnectionWrites(
            access,
            'mcpExternal',
            resolution.connectionName,
        );

        if (this.child
            && this.port === port
            && this.connectionName === resolution.connectionName
            && this.accessKey === accessKey) {
            return this.getStatus();
        }
        if (this.child) {
            await this.stop();
        }

        const connectionName = resolution.connectionName;
        const connectionDetails = resolution.details;
        const token = writesEnabled ? randomUUID() : undefined;

        const env: NodeJS.ProcessEnv = { ...process.env };
        Object.assign(
            env,
            connectionDetailsToEnv({
                ...connectionDetails,
                name: connectionDetails.name ?? connectionName
            })
        );
        env[MCP_ENV.VERSION] = MCP_SERVER_VERSION;
        env[MCP_ENV.ACCESS] = aiToolAccessToEnv(access);
        if (token) {
            env[MCP_ENV.TOKEN] = token;
        } else {
            delete env[MCP_ENV.TOKEN];
        }

        const serverEntry = path.join(this.context.extensionPath, 'dist', 'mcp', 'mcpServer.js');
        this.lastError = undefined;

        try {
            const child = spawn(process.execPath, [serverEntry, '--transport', 'http', '--port', String(port)], {
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            child.stdout.on('data', (data: Buffer) => {
                console.log(`[netezza-mcp:http] ${data.toString().trim()}`);
            });
            child.stderr.on('data', (data: Buffer) => {
                const message = data.toString().trim();
                if (message.length === 0) {
                    return;
                }
                console.error(`[netezza-mcp:http] ${message}`);
                // Audit logs and the startup banner are informational; treating
                // them as errors hides the real failure in Settings.
                if (!message.startsWith('[netezza-mcp][audit]')
                    && !message.includes('HTTP server listening on')) {
                    this.lastError = message;
                }
            });
            child.on('exit', (code: number | null, signal: string | null) => {
                if (this.child === child) {
                    this.child = undefined;
                    this.port = undefined;
                    this.connectionName = undefined;
                    this.accessKey = undefined;
                    this.token = undefined;
                    if (!this.lastError) {
                        this.lastError = `Server stopped (${signal ?? `exit ${code}`}).`;
                    }
                }
                this.didChangeStatus.fire(this.getStatus());
            });
            child.on('error', (error: Error) => {
                this.lastError = error.message;
                this.didChangeStatus.fire(this.getStatus());
            });

            this.child = child;
            this.port = port;
            this.connectionName = connectionName;
            this.accessKey = accessKey;
            this.token = token;

            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => resolve(), 500);
                child.once('error', (error: Error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
                timer.unref();
            });
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
        }

        this.didChangeStatus.fire(this.getStatus());
        return this.getStatus();
    }

    async stop(): Promise<void> {
        const child = this.child;
        if (!child) {
            return;
        }
        this.child = undefined;
        this.port = undefined;
        this.connectionName = undefined;
        this.accessKey = undefined;
        this.token = undefined;
        try {
            child.kill('SIGTERM');
        } catch {
            // Child may already be gone.
        }
        await new Promise<void>(resolve => {
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, 1000);
            child.once('exit', finish);
            child.once('error', finish);
            timer.unref();
        });
        this.didChangeStatus.fire(this.getStatus());
    }

    dispose(): void {
        void this.stop();
        this.didChangeStatus.dispose();
    }
}
