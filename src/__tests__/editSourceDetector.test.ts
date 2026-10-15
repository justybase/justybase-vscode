import { analyzeEditSource, detectEditSource } from '../results/editSourceDetector';

describe('analyzeEditSource', () => {
  it('resolves a simple single-table SELECT', () => {
    expect(analyzeEditSource('SELECT * FROM DIMDATE')).toEqual({ source: { table: 'DIMDATE' } });
    expect(analyzeEditSource('select a from SALES.DIMDATE d where a = 1')).toEqual({
      source: { schema: 'SALES', table: 'DIMDATE' },
    });
  });

  it('explains why JOIN queries are not editable', () => {
    const result = analyzeEditSource('SELECT * FROM a JOIN b ON a.id = b.id');
    expect(result.source).toBeNull();
    expect(result.reason).toMatch(/JOIN/);
  });

  it('explains why CTE, set operations and non-SELECT statements are not editable', () => {
    expect(analyzeEditSource('WITH x AS (SELECT 1) SELECT * FROM x').reason).toMatch(/CTE/);
    expect(analyzeEditSource('SELECT a FROM t UNION SELECT a FROM u').reason).toMatch(/UNION/);
    expect(analyzeEditSource('SHOW TABLES').reason).toMatch(/SELECT/);
  });

  it('explains when there is no FROM clause or no SQL text', () => {
    expect(analyzeEditSource('SELECT 1').reason).toMatch(/FROM/);
    expect(analyzeEditSource('').reason).toBeTruthy();
  });
});

describe('detectEditSource', () => {
  it('keeps the null-returning contract for non-editable queries', () => {
    expect(detectEditSource('SELECT * FROM a JOIN b ON a.id = b.id')).toBeNull();
    expect(detectEditSource('SELECT * FROM DIMDATE')).toEqual({ table: 'DIMDATE' });
  });
});
