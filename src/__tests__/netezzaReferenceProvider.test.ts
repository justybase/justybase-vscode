import { NetezzaReferenceProvider } from '../services/copilot/NetezzaReferenceProvider';

describe('NetezzaReferenceProvider', () => {
    let provider: NetezzaReferenceProvider;

    beforeEach(() => {
        provider = new NetezzaReferenceProvider();
    });

    describe('getNetezzaReference', () => {
        describe('optimization', () => {
            it('should return optimization rules', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('NETEZZA SQL NAMING CONVENTIONS');
                expect(reference).toContain('DATABASE.SCHEMA.OBJECT');
                expect(reference).toContain('DATABASE..OBJECT');
                expect(reference).toContain('DISTRIBUTE ON');
                expect(reference).toContain('ORGANIZE ON');
            });

            it('should include zone maps in optimization', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('zone maps');
                expect(reference).toContain('Zone Maps');
            });

            it('should include distribution strategy tips', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('distribution');
            });

            it('should include join optimization tips', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('join');
            });

            it('should include column optimization tips', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('SELECT *');
                expect(reference).toContain('columns');
            });
        });

        describe('nzplsql', () => {
            it('should return NZPLSQL rules', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('NZPLSQL');
                expect(reference).toContain('CREATE PROCEDURE');
                expect(reference).toContain('BEGIN');
                expect(reference).toContain('END');
            });

            it('should include variable declarations', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('DECLARE');
                expect(reference).toContain('variable');
            });

            it('should include control flow', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('IF');
                expect(reference).toContain('ELSE');
                expect(reference).toContain('LOOP');
                expect(reference).toContain('WHILE');
            });

            it('should include exception handling', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('EXCEPTION');
                expect(reference).toContain('RAISE NOTICE');
            });

            it('should include dynamic SQL', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('EXECUTE IMMEDIATE');
                expect(reference).toContain('DYNAMIC SQL');
            });

            it('should include control flow keywords', () => {
                const reference = provider.getNetezzaReference('nzplsql');

                expect(reference).toContain('IF');
                expect(reference).toContain('ELSE');
            });
        });

        describe('all', () => {
            it('should return both optimization and nzplsql references', () => {
                const reference = provider.getNetezzaReference('all');

                expect(reference).toContain('NETEZZA SQL NAMING CONVENTIONS');
                expect(reference).toContain('NZPLSQL');
            });

            it('should include all optimization rules', () => {
                const reference = provider.getNetezzaReference('all');

                expect(reference).toContain('DISTRIBUTE ON');
                expect(reference).toContain('ORGANIZE ON');
                expect(reference).toContain('zone maps');
            });

            it('should include all NZPLSQL rules', () => {
                const reference = provider.getNetezzaReference('all');

                expect(reference).toContain('CREATE PROCEDURE');
                expect(reference).toContain('DECLARE');
                expect(reference).toContain('IF');
            });
        });

        describe('formatting and structure', () => {
            it('should return well-formatted reference', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('NETEZZA OPTIMIZATION RULES TO APPLY');
                expect(reference).toContain('NETEZZA SQL NAMING CONVENTIONS');
            });

            it('should include numbered rules', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('1.');
                expect(reference).toContain('20.');
            });

            it('should use proper markdown headers for naming conventions', () => {
                const reference = provider.getNetezzaReference('all');

                expect(reference).toContain('NETEZZA SQL NAMING CONVENTIONS');
            });

            it('should include bullet points', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toMatch(/^-/m);
            });
        });

        describe('specific Netezza features', () => {
            it('should mention GROOM TABLE', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('GROOM TABLE');
            });

            it('should mention zone map creation', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('CREATE ZONEMAP');
            });

            it('should mention CTAS (Create Table As Select)', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('CREATE TABLE AS');
            });

            it('should mention materialized views', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('materialized view');
            });

            it('should mention temporary tables', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('temporary table');
                expect(reference).toContain('TEMP');
            });

            it('should mention date functions', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('DATE');
                expect(reference).toContain('TIMESTAMP');
            });

            it('should mention string functions', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('SUBSTR');
                expect(reference).toContain('CONCAT');
            });

            it('should mention aggregate functions', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('COUNT');
                expect(reference).toContain('SUM');
                expect(reference).toContain('AVG');
            });
        });

        describe('best practices', () => {
            it('should include anti-join warnings', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('NOT EXISTS');
                expect(reference).toContain('Anti-Join');
            });

            it('should include subquery warnings', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('Subquery');
                expect(reference).toContain('JOIN');
            });

            it('should include data type recommendations', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('VARCHAR');
                expect(reference).toContain('INTEGER');
            });

            it('should include NULL handling', () => {
                const reference = provider.getNetezzaReference('optimization');

                expect(reference).toContain('NULL');
                expect(reference).toContain('COALESCE');
            });
        });
    });
});
