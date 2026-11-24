import { describe, expect, it } from '@jest/globals';
import {
    DEFAULT_METADATA_PREFETCH_SCOPE,
    normalizeMetadataPrefetchScope,
} from '../../metadata/prefetchScope';

describe('metadata prefetch scope', () => {
    it('defaults to the database-scoped warm-up', () => {
        expect(DEFAULT_METADATA_PREFETCH_SCOPE).toBe('activeAndPopular');
        expect(normalizeMetadataPrefetchScope(undefined)).toBe('activeAndPopular');
        expect(normalizeMetadataPrefetchScope('anything')).toBe('activeAndPopular');
    });

    it('accepts the eager connection scope', () => {
        expect(normalizeMetadataPrefetchScope('connection')).toBe('connection');
    });
});
