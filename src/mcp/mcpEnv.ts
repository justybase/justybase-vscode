import { ConnectionDetails } from '../types';
import { normalizeDatabaseKind } from '../contracts/database';

/**
 * Connection details are transferred from the VS Code extension host to the
 * MCP server child process exclusively through environment variables.
 *
 * The password therefore never touches the file system: it travels from the
 * VS Code Secrets API directly into the `env` of the spawned server process.
 */

export const MCP_ENV = {
    HOST: 'JUSTYBASE_MCP_HOST',
    PORT: 'JUSTYBASE_MCP_PORT',
    DATABASE: 'JUSTYBASE_MCP_DATABASE',
    USER: 'JUSTYBASE_MCP_USER',
    PASSWORD: 'JUSTYBASE_MCP_PASSWORD',
    DBTYPE: 'JUSTYBASE_MCP_DBTYPE',
    OPTIONS: 'JUSTYBASE_MCP_OPTIONS',
    CONNECTION_NAME: 'JUSTYBASE_MCP_CONNECTION_NAME',
    VERSION: 'JUSTYBASE_MCP_VERSION'
} as const;

export function connectionDetailsToEnv(details: ConnectionDetails): Record<string, string> {
    const env: Record<string, string> = {};
    env[MCP_ENV.HOST] = details.host || '';
    env[MCP_ENV.PORT] = details.port !== undefined ? String(details.port) : '';
    env[MCP_ENV.DATABASE] = details.database || '';
    env[MCP_ENV.USER] = details.user || '';
    env[MCP_ENV.PASSWORD] = details.password || '';
    env[MCP_ENV.DBTYPE] = details.dbType || 'netezza';
    env[MCP_ENV.OPTIONS] = details.options ? JSON.stringify(details.options) : '';
    env[MCP_ENV.CONNECTION_NAME] = details.name || '';
    return env;
}

export function envToConnectionDetails(env: NodeJS.ProcessEnv): ConnectionDetails | undefined {
    const host = env[MCP_ENV.HOST];
    if (!host || host.length === 0) {
        return undefined;
    }

    const port = env[MCP_ENV.PORT];
    const parsedPort = port !== undefined && port.length > 0 ? Number(port) : undefined;

    let options: ConnectionDetails['options'] | undefined;
    const rawOptions = env[MCP_ENV.OPTIONS];
    if (rawOptions && rawOptions.length > 0) {
        try {
            options = JSON.parse(rawOptions) as ConnectionDetails['options'];
        } catch {
            options = undefined;
        }
    }

    return {
        name: env[MCP_ENV.CONNECTION_NAME] || undefined,
        host,
        port: parsedPort !== undefined && !Number.isNaN(parsedPort) ? parsedPort : undefined,
        database: env[MCP_ENV.DATABASE] || '',
        user: env[MCP_ENV.USER] || '',
        password: env[MCP_ENV.PASSWORD] || undefined,
        dbType: normalizeDatabaseKind(env[MCP_ENV.DBTYPE] || 'netezza'),
        options
    };
}

export function hasMcpConnectionEnv(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env[MCP_ENV.HOST]);
}
