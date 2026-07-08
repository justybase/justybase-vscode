import { oracleCopilotReferenceProvider } from '../../../../extensions/oracle/src/oracleReferenceProvider';

describe('Oracle Copilot Reference Provider', () => {
    it('returns non-empty reference for all topic', () => {
        const ref = oracleCopilotReferenceProvider.getReference('all');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('Oracle');
    });

    it('returns optimization-specific reference', () => {
        const ref = oracleCopilotReferenceProvider.getReference('optimization');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('DBMS_XPLAN');
    });

    it('returns procedure-specific reference', () => {
        const ref = oracleCopilotReferenceProvider.getReference('procedure');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('PL/SQL');
    });

    it('defaults to all topic when no argument provided', () => {
        const ref = oracleCopilotReferenceProvider.getReference();
        expect(ref).toBe(oracleCopilotReferenceProvider.getReference('all'));
    });

    it('returns different content for each topic', () => {
        const all = oracleCopilotReferenceProvider.getReference('all');
        const opt = oracleCopilotReferenceProvider.getReference('optimization');
        const proc = oracleCopilotReferenceProvider.getReference('procedure');
        expect(all).not.toBe(opt);
        expect(all).not.toBe(proc);
        expect(opt).not.toBe(proc);
    });
});
