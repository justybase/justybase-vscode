import * as crypto from 'crypto';

/**
 * Fast content hashing utility for cache invalidation.
 * Uses SHA-1 via Node's crypto module (extremely fast, no collision risk for this use case).
 */

export function simpleHash(str: string): string {
    return crypto.createHash('sha1').update(str).digest('hex');
}
