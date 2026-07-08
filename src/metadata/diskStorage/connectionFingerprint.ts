/**
 * Connection identity fingerprint for disk cache validation.
 * Excludes credentials — only host, port, database, and dialect kind.
 */

import { createHash } from 'crypto';
import type { ConnectionDetails } from '../../types';
import type { DatabaseKind } from '../../contracts/database';
import { tryNormalizeDatabaseKind } from '../../contracts/database';

export interface ConnectionFingerprintInput {
    host: string;
    port?: number;
    database: string;
    dbType?: string | DatabaseKind;
}

export function computeConnectionFingerprint(
    input: ConnectionFingerprintInput,
): string {
    const host = (input.host ?? '').trim().toLowerCase();
    const port = input.port ?? 0;
    const database = (input.database ?? '').trim().toLowerCase();
    const dbKind = input.dbType
        ? (tryNormalizeDatabaseKind(input.dbType) ?? String(input.dbType).toLowerCase())
        : 'netezza';
    const payload = `${host}|${port}|${database}|${dbKind}`;
    return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function computeFingerprintFromConnectionDetails(
    details: ConnectionDetails,
): string {
    return computeConnectionFingerprint({
        host: details.host,
        port: details.port,
        database: details.database,
        dbType: details.dbType,
    });
}
