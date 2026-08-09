import { ConnectionDetails } from '../../types';
import {
    connectionDetailsToEnv,
    envToConnectionDetails,
    hasMcpConnectionEnv,
    MCP_ENV
} from '../../mcp/mcpEnv';

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

    it('normalizes unknown dbType to netezza', () => {
        const env = connectionDetailsToEnv({ host: 'h', database: 'd', user: 'u', dbType: 'unknown' as never });
        expect(envToConnectionDetails(env)?.dbType).toBe('netezza');
    });

    it('hasMcpConnectionEnv detects connection presence', () => {
        expect(hasMcpConnectionEnv({})).toBe(false);
        expect(hasMcpConnectionEnv({ [MCP_ENV.HOST]: 'h' })).toBe(true);
    });
});
