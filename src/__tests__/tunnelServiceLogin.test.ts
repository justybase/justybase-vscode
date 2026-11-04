import {
    assertServiceLoginUrl,
    TunnelServiceLogin,
    type ServiceLoginResponse,
} from '../core/tunnelServiceLogin';

function tokenResponse(token: string, expiresIn = 900): ServiceLoginResponse {
    return {
        status: 200,
        body: JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: expiresIn }),
    };
}

describe('assertServiceLoginUrl', () => {
    it.each([
        'https://service.example.test',
        'wss://service.example.test/api/justybase',
        'http://127.0.0.1:8000',
        'http://localhost:8000',
        'ws://[::1]:8000',
    ])('accepts %s', url => {
        expect(() => assertServiceLoginUrl(url)).not.toThrow();
    });

    it.each(['http://service.example.test', 'ws://10.0.0.5:8000'])('refuses plain traffic to %s', url => {
        expect(() => assertServiceLoginUrl(url)).toThrow('requires an HTTPS URL');
    });

    it('refuses a look-alike of a loopback name', () => {
        expect(() => assertServiceLoginUrl('http://localhost.example.test')).toThrow('requires an HTTPS URL');
    });

    it('refuses credentials embedded in the URL', () => {
        expect(() => assertServiceLoginUrl('https://user:secret@service.example.test')).toThrow(
            'must not contain a login or password',
        );
    });
});

describe('TunnelServiceLogin', () => {
    const baseUrl = 'https://service.example.test/api/justybase';

    it('posts the login to {base}/auth/token', async () => {
        const transport = jest.fn(async () => tokenResponse('jwt-1'));
        const login = new TunnelServiceLogin(baseUrl, 'analyst', 'secret', transport);

        await expect(login.getToken()).resolves.toBe('jwt-1');

        expect(transport).toHaveBeenCalledTimes(1);
        const [url, body] = transport.mock.calls[0] as unknown as [URL, string];
        expect(url.toString()).toBe('https://service.example.test/api/justybase/auth/token');
        expect(JSON.parse(body)).toEqual({ username: 'analyst', password: 'secret' });
    });

    it('uses https for a wss base URL', async () => {
        const transport = jest.fn(async () => tokenResponse('jwt-1'));
        const login = new TunnelServiceLogin('wss://service.example.test', 'a', 'b', transport);

        await login.getToken();

        const [url] = transport.mock.calls[0] as unknown as [URL];
        expect(url.protocol).toBe('https:');
    });

    it('reuses a valid token', async () => {
        const transport = jest.fn(async () => tokenResponse('jwt-1'));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport);

        await login.getToken();
        await login.getToken();

        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('logs in once when many connections ask together', async () => {
        const transport = jest.fn(async () => tokenResponse('jwt-1'));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport);

        const tokens = await Promise.all([login.getToken(), login.getToken(), login.getToken()]);

        expect(tokens).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('logs in again 60 seconds before the token expires', async () => {
        let now = 1_000_000;
        const transport = jest.fn()
            .mockResolvedValueOnce(tokenResponse('jwt-1', 900))
            .mockResolvedValueOnce(tokenResponse('jwt-2', 900));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport, () => now);

        await login.getToken();
        now += 839_000;
        await expect(login.getToken()).resolves.toBe('jwt-1');
        now += 1_000;
        await expect(login.getToken()).resolves.toBe('jwt-2');
    });

    it('still caches a token that lives for less than the refresh margin', async () => {
        let now = 1_000_000;
        const transport = jest.fn()
            .mockResolvedValueOnce(tokenResponse('jwt-1', 30))
            .mockResolvedValueOnce(tokenResponse('jwt-2', 30));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport, () => now);

        await login.getToken();
        now += 14_000;
        await expect(login.getToken()).resolves.toBe('jwt-1');
        now += 1_000;
        await expect(login.getToken()).resolves.toBe('jwt-2');
    });

    it('forgets only the token the server refused', async () => {
        const transport = jest.fn()
            .mockResolvedValueOnce(tokenResponse('jwt-1'))
            .mockResolvedValueOnce(tokenResponse('jwt-2'));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport);

        await login.getToken();
        login.invalidate('some-older-token');
        await expect(login.getToken()).resolves.toBe('jwt-1');
        login.invalidate('jwt-1');
        await expect(login.getToken()).resolves.toBe('jwt-2');
    });

    it('reports a rejected login clearly', async () => {
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', async () => ({ status: 401, body: '{}' }));

        await expect(login.getToken()).rejects.toThrow('The service rejected the login or password.');
    });

    it('treats a redirect as a failure, so credentials are not sent elsewhere', async () => {
        const transport = jest.fn(async () => ({ status: 302, body: '' }));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport);

        await expect(login.getToken()).rejects.toThrow('HTTP 302');
        expect(transport).toHaveBeenCalledTimes(1);
    });

    it('does not repeat the response body in an error', async () => {
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', async () => ({
            status: 500,
            body: 'traceback with secret-value',
        }));

        await expect(login.getToken()).rejects.not.toThrow('secret-value');
    });

    it.each([
        ['not json', 'not-json'],
        ['no token', JSON.stringify({ expires_in: 900 })],
        ['empty token', JSON.stringify({ access_token: '', expires_in: 900 })],
        ['no expiry', JSON.stringify({ access_token: 'jwt' })],
        ['past expiry', JSON.stringify({ access_token: 'jwt', expires_in: 0 })],
        ['null body', 'null'],
    ])('refuses an invalid login response: %s', async (_name, body) => {
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', async () => ({ status: 200, body }));

        await expect(login.getToken()).rejects.toThrow('invalid login response');
    });

    it('can log in again after a failed attempt', async () => {
        const transport = jest.fn()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce(tokenResponse('jwt-1'));
        const login = new TunnelServiceLogin(baseUrl, 'a', 'b', transport);

        await expect(login.getToken()).rejects.toThrow('network down');
        await expect(login.getToken()).resolves.toBe('jwt-1');
    });

    it('refuses an insecure URL when constructed', () => {
        expect(() => new TunnelServiceLogin('http://service.example.test', 'a', 'b')).toThrow('requires an HTTPS URL');
    });
});
