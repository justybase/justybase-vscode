import { isAuthorizedHttpRequest } from '../../mcp/mcpHttpAuth';

describe('MCP HTTP bearer-token gate', () => {
    it('allows every request when no write token is configured', () => {
        expect(isAuthorizedHttpRequest({}, undefined)).toBe(true);
        expect(isAuthorizedHttpRequest({ authorization: 'Bearer anything' }, undefined)).toBe(true);
        expect(isAuthorizedHttpRequest({ authorization: '' }, '')).toBe(true);
    });

    it('requires the exact bearer token once writes are enabled', () => {
        const token = '2f0e6f0f-6c47-4e1a-9d5d-8d6f0c0b1a2e';

        expect(isAuthorizedHttpRequest({ authorization: `Bearer ${token}` }, token)).toBe(true);
        expect(isAuthorizedHttpRequest({ authorization: ['Bearer ' + token] }, token)).toBe(true);
        expect(isAuthorizedHttpRequest({}, token)).toBe(false);
        expect(isAuthorizedHttpRequest({ authorization: token }, token)).toBe(false);
        expect(isAuthorizedHttpRequest({ authorization: 'Bearer wrong' }, token)).toBe(false);
    });
});
