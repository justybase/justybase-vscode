import { findTokenContaining, tokenizeSql } from './netezzaTmGrammarHarness';

describe('scope dump', () => {
  it('dumps scopes for db..table vs 3-part CREATE TABLE', async () => {
    const sqlDbTable = `CREATE TABLE JUST_DATA..TEST2 AS 
(
    SELECT * FROM DIMDATE
);`;
    const sql3Part = `CREATE TABLE JUST_DATA.ADMIN.TEST2 AS 
(
    SELECT * FROM DIMDATE
);`;

    const report: string[] = [];
    for (const [label, sql] of [
      ['db..table', sqlDbTable],
      ['3-part', sql3Part],
    ] as const) {
      const tokens = await tokenizeSql(sql);
      for (const id of ['JUST_DATA', 'ADMIN', 'TEST2']) {
        if (!sql.includes(id)) continue;
        const token = findTokenContaining(tokens, id, { onlyActiveCode: true });
        report.push(`${label} ${id}: ${token?.scopes.join(' <- ') ?? 'MISSING'}`);
      }
    }
    expect(report.join('\n')).toMatchSnapshot();
    const dbTableJustData = report.find((line) => line.startsWith('db..table JUST_DATA:'));
    expect(dbTableJustData).toContain('constant.other.database-name.sql');
    expect(dbTableJustData).not.toContain('entity.name.function.sql');
  });
});
