import { duckdbCopilotReferenceProvider } from '../../../../extensions/duckdb/src/duckdbReferenceProvider';

describe('DuckDB Copilot Reference Provider', () => {
    it('returns non-empty reference for all topic', () => {
        const ref = duckdbCopilotReferenceProvider.getReference('all');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('DuckDB');
    });

    it('returns optimization-specific reference', () => {
        const ref = duckdbCopilotReferenceProvider.getReference('optimization');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('EXPLAIN');
    });

    it('returns procedure-specific reference', () => {
        const ref = duckdbCopilotReferenceProvider.getReference('procedure');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('macro');
    });

    it('defaults to all topic when no argument provided', () => {
        const ref = duckdbCopilotReferenceProvider.getReference();
        expect(ref).toBe(duckdbCopilotReferenceProvider.getReference('all'));
    });

    it('returns different content for each topic', () => {
        const all = duckdbCopilotReferenceProvider.getReference('all');
        const opt = duckdbCopilotReferenceProvider.getReference('optimization');
        const proc = duckdbCopilotReferenceProvider.getReference('procedure');
        expect(all).not.toBe(opt);
        expect(all).not.toBe(proc);
        expect(opt).not.toBe(proc);
    });
});
