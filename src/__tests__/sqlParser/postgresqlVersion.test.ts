jest.unmock('chevrotain');
import { getPostgresqlVersionDiagnostics } from '../../dialects/postgresql/versionDiagnostics';
import cases from './fixtures/postgresqlConformance.json';

describe('PostgreSQL server-version diagnostics', () => {
  it.each([
    ['json-table', 17], ['merge-returning', 17], ['merge-by-source', 17],
    ['returning-old-new', 18], ['virtual', 18],
  ])('%s reports the minimum version only for an older known connection', (name, minimum) => {
    const sql = cases.find(c => c.id === 'postgresql.parser.' + name + '.001')!.sql;
    expect(getPostgresqlVersionDiagnostics(sql, 160013).map(d => d.code)).toContain('PG001');
    expect(getPostgresqlVersionDiagnostics(sql, Number(minimum) * 10000)).toEqual([]);
    expect(getPostgresqlVersionDiagnostics(sql)).toEqual([]);
  });
  it('does not inspect literals and comments for version-specific keywords', () => {
    expect(getPostgresqlVersionDiagnostics("SELECT 'JSON_TABLE RETURNING WITH VIRTUAL'; -- JSON_TABLE", 160013)).toEqual([]);
  });
});
