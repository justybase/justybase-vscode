import { normalizeMigrationSourceSql, wrapMigrationSourceSql } from '../migration/sourceSql';

describe('wrapMigrationSourceSql', () => {
    it('omits AS for Oracle derived-table aliases', () => {
        expect(wrapMigrationSourceSql('SELECT * FROM TESTUSER.SALES', 'oracle')).toBe(
            'SELECT * FROM (\nSELECT * FROM TESTUSER.SALES\n) MIG_SRC',
        );
    });

    it('uses AS for dialects that support the standard derived-table alias form', () => {
        expect(wrapMigrationSourceSql('SELECT * FROM SALES', 'netezza', 'SELECT COUNT(*)')).toBe(
            'SELECT COUNT(*) FROM (\nSELECT * FROM SALES\n) AS MIG_SRC',
        );
    });

    it('removes a statement terminator before nesting the source query', () => {
        expect(normalizeMigrationSourceSql('  SELECT * FROM TESTUSER.SALES;;;  ')).toBe('SELECT * FROM TESTUSER.SALES');
    });
});
