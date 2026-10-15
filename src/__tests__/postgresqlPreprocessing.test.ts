import { MacroPreprocessor } from '../core/macroPreprocessor';

describe('PostgreSQL execution preprocessing', () => {
  it.each([false, true])('keeps routine bodies opaque (replaceVariables=%s)', async replaceVariables => {
    const sql = "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $żółć$\n%put hidden;\nSELECT &missing, %sql(SELECT 99);\n$żółć$;\nSELECT &outside;";
    const query = jest.fn(async () => ({ rows: [[99]] }));
    const result = await new MacroPreprocessor().processScript(sql,
      { replaceVariables, initialValues: { outside: '1' } }, { databaseKind: 'postgresql', query });
    expect(result.sql).toBe(replaceVariables ? sql.replace('&outside', '1') : sql);
    expect(result.unresolvedVariables).toEqual([]);
    expect(result.putMessages).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('preserves escape strings and nested comments during execution', async () => {
    const sql = String.raw`SELECT E'a\'; %sql(SELECT 1) &missing'; /* outer /* inner */
%put hidden;
*/ SELECT 1;`;
    const query = jest.fn(async () => ({ rows: [[99]] }));
    const result = await new MacroPreprocessor().processScript(sql, {}, { databaseKind: 'postgresql', query });
    expect(result.sql).toBe(sql);
    expect(result.putMessages).toEqual([]);
    expect(result.unresolvedVariables).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
