import { describe, expect, it } from '@jest/globals';
import { getDatabaseSqlAuthoring } from '../core/sqlAuthoringRegistry';

describe('Oracle SQL authoring', () => {
  it('exposes Oracle types, built-ins, signatures and static assets', () => {
    const authoring = getDatabaseSqlAuthoring('oracle');

    expect(authoring.validation.getTypeSpec('TIMESTAMP WITH TIME ZONE')?.canonical).toBe('TIMESTAMP WITH TIME ZONE');
    expect(authoring.validation.getTypeSpec('VARCHAR2')?.warnIfNoLength).toBe(true);
    expect(authoring.validation.builtinFunctions.has('REGEXP_LIKE')).toBe(true);
    expect(authoring.signatures.get('TO_DATE')?.[0].parameters).toEqual(['value', 'format?']);
    expect(authoring.qualityRules.map((rule) => rule.id)).toEqual(['ORA001', 'ORA002', 'ORA003', 'ORA004']);
    expect(authoring.staticAssets?.grammarPath).toBe('dialects/oracle/syntaxes/oracle.tmLanguage.json');
  });

  it('does not register Netezza-only NZ/NZP quality rules', () => {
    const authoring = getDatabaseSqlAuthoring('oracle');

    expect(authoring.qualityRules.some((rule) => rule.id.startsWith('NZ'))).toBe(false);
  });

  it('runs Oracle safety rules for destructive DML and ROWNUM ordering', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check('DELETE FROM "APP"."ORDERS"; UPDATE ORDERS SET STATUS = 1; SELECT * FROM ORDERS WHERE ROWNUM <= 10 ORDER BY CREATED_AT;'));

    expect(issues.map((issue) => issue.ruleId)).toEqual(['ORA001', 'ORA002', 'ORA003', 'ORA004']);
  });

  it('does not treat semicolons in strings or comments as statement terminators', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "UPDATE ORDERS SET NOTE = 'x; y' WHERE ID = 1; -- another; terminator\n",
    ));

    expect(issues.map((issue) => issue.ruleId)).not.toContain('ORA003');
  });

  it('does not treat semicolons inside q-quote alternate quoting as statement terminators', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "UPDATE ORDERS SET NOTE = q'[x; y]' WHERE ID = 1; SELECT 1 FROM DUAL;",
    ));

    expect(issues.map((issue) => issue.ruleId)).not.toContain('ORA003');
  });

  it('handles q-quote with different delimiters (brackets, braces, angle brackets, parentheses)', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "SELECT q'{test;}' FROM DUAL; SELECT q'<test;>' FROM DUAL; SELECT q'(test;)' FROM DUAL;",
    ));

    expect(issues.map((issue) => issue.ruleId)).not.toContain('ORA003');
  });

  it('handles q-quote with matching bracket delimiters (opening and closing different)', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "SELECT q'[test;]' FROM DUAL; SELECT q'{test;}' FROM DUAL; SELECT q'<test;>' FROM DUAL; SELECT q'(test;)' FROM DUAL;",
    ));

    expect(issues.map((issue) => issue.ruleId)).not.toContain('ORA003');
  });

  it('requires the closing apostrophe after a q-quote delimiter', () => {
    const rules = getDatabaseSqlAuthoring('oracle').qualityRules;
    const issues = rules.flatMap((rule) => rule.check(
      "UPDATE ORDERS SET NOTE = q'[x]' ; SELECT * FROM DUAL WHERE 1 = 1;",
    ));

    expect(issues.filter((issue) => issue.ruleId === 'ORA003')).toHaveLength(1);
  });
});
