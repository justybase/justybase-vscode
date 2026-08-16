import { planStatements } from '../src/server';

describe('web query planning', () => {
  it('uses the parser-selected statement for Run with a cursor', () => {
    const input = { connectionId: 'c1', sql: 'SELECT 1; SELECT 2;', mode: 'single' as const, cursorOffset: 12 };
    const planned = planStatements(input);
    expect(planned.mode).toBe('single');
    expect(planned.statements).toEqual([{ index: 0, startOffset: 10, endOffset: 18, sql: 'SELECT 2' }]);
  });

  it('splits Smart run and Batch scripts with stable statement indexes', () => {
    const planned = planStatements({ connectionId: 'c1', sql: "SELECT 'a;b'; SELECT 2;", mode: 'script' });
    expect(planned.statements.map(statement => statement.index)).toEqual([0, 1]);
    expect(planned.statements.map(statement => statement.sql)).toEqual(["SELECT 'a;b'", 'SELECT 2']);
  });

  it('rejects scripts without executable statements', () => {
    expect(() => planStatements({ connectionId: 'c1', sql: ' -- only a comment', mode: 'script' })).toThrow('executable statement');
  });

  it('plans Explain for only the statement under the cursor', () => {
    const planned = planStatements({ connectionId: 'c1', sql: 'SELECT 1; UPDATE T SET A = 2;', mode: 'explain', cursorOffset: 18 });
    expect(planned.mode).toBe('explain');
    expect(planned.statements).toEqual([{ index: 0, startOffset: 10, endOffset: 28, sql: 'EXPLAIN VERBOSE UPDATE T SET A = 2' }]);
  });

  it('uses the native Explain form for local database dialects', () => {
    expect(planStatements({ connectionId: 'c1', sql: 'SELECT * FROM T', mode: 'explain' }, 'sqlite').statements[0]?.sql).toBe('EXPLAIN QUERY PLAN SELECT * FROM T');
    expect(planStatements({ connectionId: 'c1', sql: 'SELECT * FROM T', mode: 'explain' }, 'duckdb').statements[0]?.sql).toBe('EXPLAIN SELECT * FROM T');
  });
});
