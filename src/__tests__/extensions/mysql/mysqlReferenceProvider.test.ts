import { mysqlCopilotReferenceProvider } from '../../../../extensions/mysql/src/mysqlReferenceProvider';

describe('MySQL Copilot Reference Provider', () => {
    it('returns non-empty reference for all topic', () => {
        const ref = mysqlCopilotReferenceProvider.getReference('all');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('MySQL');
    });

    it('returns optimization-specific reference', () => {
        const ref = mysqlCopilotReferenceProvider.getReference('optimization');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('EXPLAIN');
    });

    it('returns procedure-specific reference', () => {
        const ref = mysqlCopilotReferenceProvider.getReference('procedure');
        expect(ref.length).toBeGreaterThan(0);
        expect(ref).toContain('stored procedure');
    });

    it('defaults to all topic when no argument provided', () => {
        const ref = mysqlCopilotReferenceProvider.getReference();
        expect(ref).toBe(mysqlCopilotReferenceProvider.getReference('all'));
    });

    it('returns different content for each topic', () => {
        const all = mysqlCopilotReferenceProvider.getReference('all');
        const opt = mysqlCopilotReferenceProvider.getReference('optimization');
        const proc = mysqlCopilotReferenceProvider.getReference('procedure');
        expect(all).not.toBe(opt);
        expect(all).not.toBe(proc);
        expect(opt).not.toBe(proc);
    });
});
