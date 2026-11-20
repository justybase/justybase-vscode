/**
 * Bearer-token gate for the HTTP MCP transport.
 *
 * Read-only HTTP stays tokenless for local clients. As soon as the policy
 * exposes a write tool, the extension generates a per-run token and every
 * request must present it.
 */

export interface HttpAuthorizationHeaders {
    readonly authorization?: string | readonly string[] | undefined;
}

export function isAuthorizedHttpRequest(
    headers: HttpAuthorizationHeaders,
    token: string | undefined,
): boolean {
    if (!token) {
        return true;
    }
    const value = Array.isArray(headers.authorization)
        ? headers.authorization[0]
        : headers.authorization;
    return value === `Bearer ${token}`;
}
