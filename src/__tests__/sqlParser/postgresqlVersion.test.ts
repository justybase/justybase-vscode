jest.unmock('chevrotain');
import { getPostgresqlVersionDiagnostics } from '../../dialects/postgresql/versionDiagnostics';

// Hand-maintained regression SQL for server-version diagnostics. This test is
// independent of the shared SQL conformance corpus and runs in standard CI.
const cases = [
  { id: 'postgresql.parser.json-table.001', sql: 'SELECT * FROM JSON_TABLE(\'[{"id":1}]\', \'$[*]\' COLUMNS(id integer PATH \'$.id\')) AS jt' },
  { id: 'postgresql.parser.merge-returning.001', sql: 'MERGE INTO items i USING other o ON i.id=o.id WHEN MATCHED THEN DELETE RETURNING i.id' },
  { id: 'postgresql.parser.merge-by-source.001', sql: 'MERGE INTO items i USING other o ON i.id=o.id WHEN NOT MATCHED BY SOURCE THEN DELETE' },
  { id: 'postgresql.parser.returning-old-new.001', sql: 'UPDATE items SET id=1 RETURNING WITH (OLD AS o, NEW AS n) o.id, n.id' },
  { id: 'postgresql.parser.virtual.001', sql: 'CREATE TABLE t(id integer, doubled integer GENERATED ALWAYS AS (id * 2) VIRTUAL)' },
];

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
