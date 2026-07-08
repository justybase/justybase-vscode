import { db2CopilotReferenceProvider } from '../../../../extensions/db2/src/db2ReferenceProvider';

describe('Db2 Copilot Reference Provider', () => {
    it('returns non-empty reference for all topic', () => {
        const ref = db2CopilotReferenceProvider.getReference('all');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('Db2');
    });

    it('returns optimization-specific reference', () => {
        const ref = db2CopilotReferenceProvider.getReference('optimization');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('RUNSTATS');
    });

    it('returns procedure-specific reference', () => {
        const ref = db2CopilotReferenceProvider.getReference('procedure');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('SQL PL');
    });

    it('defaults to all topic when no argument provided', () => {
        const ref = db2CopilotReferenceProvider.getReference();
        expect(ref).toBe(db2CopilotReferenceProvider.getReference('all'));
    });

    it('returns different content for each topic', () => {
        const all = db2CopilotReferenceProvider.getReference('all');
        const opt = db2CopilotReferenceProvider.getReference('optimization');
        const proc = db2CopilotReferenceProvider.getReference('procedure');
        expect(all).not.toBe(opt);
        expect(all).not.toBe(proc);
        expect(opt).not.toBe(proc);
    });
});
