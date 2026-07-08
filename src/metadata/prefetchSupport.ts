import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';

export function supportsLegacyMetadataPrefetch(kind?: string | DatabaseKind): boolean {
    if (!kind) {
        return true;
    }

    return tryNormalizeDatabaseKind(kind) === 'netezza';
}
