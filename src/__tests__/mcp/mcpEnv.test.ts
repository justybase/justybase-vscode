import { ConnectionDetails } from '../../types';
import {
    aiToolAccessToEnv,
    connectionDetailsToEnv,
    envToConnectionDetails,
    hasMcpConnectionEnv,
    MCP_ENV,
    parseMcpAiToolAccess
} from '../../mcp/mcpEnv';
import {
    DEFAULT_AI_TOOL_ACCESS,
    effectiveToolTier,
    normalizeAiToolAccess
} from '../../core/assistant/toolPolicy';
import { getAssistantTool } from '../../core/assistant/toolCatalog';

describe('MCP connection env serialization', () => {
    const details: ConnectionDetails = {
        name: 'Dev Netezza',
        host: 'nz.example.com',
        port: 5480,
        database: 'DWH',
        user: 'ADMIN',
        password: 'secret-value',
        dbType: 'netezza',
        options: { ssl: true }
    };

    it('round-trips all connection fields including the password', () => {
        const env = connectionDetailsToEnv(details);
        expect(env[MCP_ENV.HOST]).toBe('nz.example.com');
        expect(env[MCP_ENV.PASSWORD]).toBe('secret-value');
        expect(env[MCP_ENV.OPTIONS]).toBe('{"ssl":true}');

        const restored = envToConnectionDetails(env);
        expect(restored).toEqual(details);
    });

    it('returns undefined when host is missing', () => {
        expect(envToConnectionDetails({})).toBeUndefined();
        expect(envToConnectionDetails({ [MCP_ENV.HOST]: '' })).toBeUndefined();
    });

    it('tolerates malformed options JSON', () => {
        const env = connectionDetailsToEnv({ host: 'h', database: 'd', user: 'u' });
        env[MCP_ENV.OPTIONS] = '{not-json';
        const restored = envToConnectionDetails(env);
        expect(restored?.host).toBe('h');
        expect(restored?.options).toBeUndefined();
    });

    it('falls back to Netezza for an explicitly unknown dbType', () => {
        const env = connectionDetailsToEnv({ host: 'h', database: 'd', user: 'u', dbType: 'unknown' as never });
        expect(envToConnectionDetails(env)?.dbType).toBe('netezza');
    });

    it('hasMcpConnectionEnv detects connection presence', () => {
        expect(hasMcpConnectionEnv({})).toBe(false);
        expect(hasMcpConnectionEnv({ [MCP_ENV.HOST]: 'h' })).toBe(true);
    });

    it('round-trips the access policy through the child environment', () => {
        const access = normalizeAiToolAccess({
            mcp: { access: 'read-write', overrides: { execute_sql: 'read' } },
            mcpExternal: 'full',
            writableConnections: ['Dev Netezza']
        });
        const env = { [MCP_ENV.ACCESS]: aiToolAccessToEnv(access) };

        expect(parseMcpAiToolAccess(env)).toEqual(access);
    });

    it('falls back to disabled tools for missing or malformed access env', () => {
        expect(parseMcpAiToolAccess({})).toEqual(DEFAULT_AI_TOOL_ACCESS);
        expect(parseMcpAiToolAccess({ [MCP_ENV.ACCESS]: '{not-json' })).toEqual(DEFAULT_AI_TOOL_ACCESS);
    });

    it('requires the MCP connection to be listed before write tools are exposed', () => {
        const executeSql = getAssistantTool('execute_sql')!;
        const writeAccess = normalizeAiToolAccess({
            mcp: 'read-write',
            writableConnections: ['Dev Netezza']
        });

        expect(effectiveToolTier(executeSql, 'mcp', writeAccess, 'Dev Netezza')).toBe('write');
        expect(effectiveToolTier(executeSql, 'mcp', writeAccess, 'Production')).toBeUndefined();
        expect(effectiveToolTier(executeSql, 'mcp', DEFAULT_AI_TOOL_ACCESS, 'Dev Netezza')).toBeUndefined();
    });
});
