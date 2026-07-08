import { mssqlCopilotReferenceProvider } from '../../../../extensions/mssql/src/mssqlReferenceProvider';

describe('MSSQL Copilot Reference Provider', () => {
    it('returns non-empty reference for all topic', () => {
        const ref = mssqlCopilotReferenceProvider.getReference('all');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('SQL Server');
    });

    it('returns optimization-specific reference', () => {
        const ref = mssqlCopilotReferenceProvider.getReference('optimization');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('execution plan');
    });

    it('returns procedure-specific reference', () => {
        const ref = mssqlCopilotReferenceProvider.getReference('procedure');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('T-SQL');
    });

    it('defaults to all topic when no argument provided', () => {
        const ref = mssqlCopilotReferenceProvider.getReference();
        expect(ref).toBe(mssqlCopilotReferenceProvider.getReference('all'));
    });

    it('returns different content for each topic', () => {
        const all = mssqlCopilotReferenceProvider.getReference('all');
        const opt = mssqlCopilotReferenceProvider.getReference('optimization');
        const proc = mssqlCopilotReferenceProvider.getReference('procedure');
        expect(all).not.toBe(opt);
        expect(all).not.toBe(proc);
        expect(opt).not.toBe(proc);
    });
});
