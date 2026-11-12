import type { DatabaseConnectionOptions } from '../contracts/database';
import type { NetezzaDriverConfig } from '@justybase/netezza-runtime';

export type NetezzaTlsDriverOptions = Pick<
    NetezzaDriverConfig,
    'securityLevel' | 'rejectUnauthorized' | 'sslCerFilePath'
>;

function optionString(options: DatabaseConnectionOptions | undefined, key: string): string | undefined {
    const value = options?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Maps the Netezza connection form options to the flat fields expected by
 * `@justybase/netezza-driver`.
 *
 * `netezzaSslMode` is intentionally Netezza-specific: `sslMode` is already a
 * legacy PostgreSQL marker used by the connection-kind inference.
 * The `sslMode` / `sslRootCert` aliases are accepted for imported profiles.
 */
export function getNetezzaTlsDriverOptions(
    options: DatabaseConnectionOptions | undefined,
): NetezzaTlsDriverOptions {
    const mode = (optionString(options, 'netezzaSslMode') ?? optionString(options, 'sslMode'))?.toLowerCase();
    const caPath = optionString(options, 'netezzaSslRootCert') ?? optionString(options, 'sslRootCert');

    switch (mode) {
        case undefined:
        case '':
        case 'default':
            return caPath ? { sslCerFilePath: caPath } : {};
        case 'disable':
            return { securityLevel: 'OnlyUnsecuredSession' };
        case 'require':
            return {
                securityLevel: 'OnlySecuredSession',
                rejectUnauthorized: false
            };
        case 'verify-full':
        case 'verify-ca':
            return {
                securityLevel: 'OnlySecuredSession',
                rejectUnauthorized: true,
                ...(caPath ? { sslCerFilePath: caPath } : {})
            };
        default:
            return {};
    }
}
