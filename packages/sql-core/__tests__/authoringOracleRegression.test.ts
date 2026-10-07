jest.unmock('chevrotain');
import { parseNetezzaSqlStatements } from '../src/parser/runtime';
import { NetezzaSqlSemanticValidator } from '../src/validation';

describe('live-backed authoring syntax', () => {
  test.each([
    "SELECT INTERVAL '1' DAY",
    "SELECT CURRENT_TIMESTAMP + INTERVAL '1' DAY",
    "SELECT CAST('2020-01-01' AS TIMESTAMPTZ)",
    "SELECT TIMESTAMPTZ '2023-01-01 12:00:00 UTC'",
    'CREATE MATERIALIZED VIEW t AS SELECT 7 AS ID',
    'CREATE MATERIALIZED VIEW t AS SELECT ID FROM s WHERE 1=0',
    'MERGE INTO t T USING s S ON T.ID=S.ID WHEN MATCHED THEN DELETE WHERE T.ID=1',
    'MERGE INTO t T USING s S ON T.ID=S.ID WHEN MATCHED THEN INSERT (ID) VALUES (S.ID)',
    'MERGE INTO t T USING s S ON T.ID=S.ID WHEN NOT MATCHED THEN UPDATE SET T.ID=S.ID',
    'MERGE INTO t T USING s S ON T.ID=S.ID WHEN NOT MATCHED THEN DELETE',
    'MERGE INTO t T USING s S ON T.ID=S.ID WHEN MATCHED THEN UPDATE SET T.ID=S.ID WHERE T.ID=1',
    'ALTER TABLE t',
  ])('rejects %s', sql => {
    const parsed = parseNetezzaSqlStatements({ sql });
    const pre = new NetezzaSqlSemanticValidator().runPreParseChecks(parsed.lexResult);
    expect(parsed.parserErrors.length + pre.errors.length).toBeGreaterThan(0);
  });

  test.each(['SELECT DATABASE FROM _V_DATABASE LIMIT 1', 'ALTER TABLE t MODIFY COLUMN NAME VARCHAR(80)',
    'CREATE MATERIALIZED VIEW v AS (SELECT id FROM t)'])
    ('accepts %s', sql => expect(parseNetezzaSqlStatements({ sql }).parserErrors).toHaveLength(0));
});
