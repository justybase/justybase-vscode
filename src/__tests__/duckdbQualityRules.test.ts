import { describe, expect, it } from '@jest/globals';
import { getDatabaseSqlAuthoring } from '../core/sqlAuthoringRegistry';

describe('DuckDB SQL quality rules', () => {
  it('exposes the DuckDB DDK rules without Netezza-only rules', () => {
    const rules = getDatabaseSqlAuthoring('duckdb').qualityRules;

    expect(rules.map((rule) => rule.id)).toEqual(['DDK001', 'DDK002', 'DDK003']);
    expect(rules.some((rule) => rule.id.startsWith('NZ'))).toBe(false);
  });

  it('checks DuckDB destructive DML and ignores comments/literals', () => {
    const rules = getDatabaseSqlAuthoring('duckdb').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "SELECT * FROM orders; DELETE FROM orders; UPDATE orders SET status = 1; -- DELETE FROM ignored\nSELECT 'UPDATE x SET y = 1'",
    ));

    expect(issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining(['DDK001', 'DDK002', 'DDK003']),
    );
    expect(issues).toHaveLength(3);
  });

  it('warns on File SQL writes but permits generated editable tables', () => {
    const rules = getDatabaseSqlAuthoring('file').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      'INSERT INTO source VALUES (1); UPDATE source_edit SET value = 2; DELETE FROM source; -- INSERT INTO ignored VALUES (1)',
    ));

    expect(issues.map((issue) => issue.ruleId)).toEqual(
      expect.arrayContaining(['FSL001', 'DDK002', 'DDK003']),
    );
    expect(issues.filter((issue) => issue.ruleId === 'FSL001')).toHaveLength(2);
  });
});
