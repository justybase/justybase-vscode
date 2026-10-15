jest.unmock('chevrotain');
import cases from './fixtures/postgresqlConformance.json';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { SqlParser } from '../../sql/sqlParser';
import { buildSqlSourceScanIndex } from '@justybase/sql-core/sourceScan';
import { createSqlParserInstance } from '../../dialects/postgresql/sql/parser';

describe('PostgreSQL conformance snapshot', () => {
  it.each(cases)('$id', ({ sql, expect: expected }) => {
    const result = parseSqlStatements({ sql, databaseKind: 'postgresql' });
    if (expected.valid) expect([...result.lexResult.errors, ...result.actionableParserErrors].map(e => e.message)).toEqual([]);
    expect({ sql, valid: result.lexResult.errors.length === 0 && result.actionableParserErrors.length === 0 }).toEqual({ sql, valid: expected.valid });
  });
  it('keeps semicolons, comments and macro-looking text inside dollar bodies', () => {
    const sql = "SELECT $tag$a;b; -- $tag$; SELECT 2;";
    const statements = SqlParser.splitStatementsWithPositions(sql, 'postgresql');
    expect(statements.map(s => s.sql)).toEqual(["SELECT $tag$a;b; -- $tag$", "SELECT 2"]);
    for (const s of statements) expect(sql.slice(s.startOffset, s.endOffset)).toBe(s.sql);
    const scan = buildSqlSourceScanIndex(sql, 'postgresql');
    expect(scan.isInString(sql.indexOf('a;b'))).toBe(true);
    expect(scan.sanitized.length).toBe(sql.length);
  });
  it('keeps escaped quotes and unterminated bodies out of subsequent statements', () => {
    expect(SqlParser.splitStatements(String.raw`SELECT E'a\';b'; SELECT 2;`, 'postgresql')).toHaveLength(2);
    expect(SqlParser.splitStatements('SELECT $x$a;b; SELECT 2;', 'postgresql')).toHaveLength(1);
  });
  it('creates an independent parser below the construction budget', () => {
    const start = performance.now();
    expect(createSqlParserInstance()).toBeDefined();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
