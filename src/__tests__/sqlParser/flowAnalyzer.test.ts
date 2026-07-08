jest.unmock('chevrotain');

import { analyzeSqlScriptFlow } from '../../sqlParser/flowAnalyzer';

describe('analyzeSqlScriptFlow', () => {
    it('builds lineage for created temp table references across statements', () => {
        const sql = `CREATE TEMP TABLE AVC AS
SELECT A.ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT A;

SELECT Y.ACCOUNTKEY FROM AVC Y;

DROP TABLE AVC IF EXISTS;`;

        const analysis = analyzeSqlScriptFlow(sql);
        const avcEdges = analysis.lineage.filter(edge => edge.objectName.toUpperCase() === 'AVC');

        expect(avcEdges.length).toBeGreaterThanOrEqual(2);
        expect(avcEdges.some(edge => edge.definitionStatementIndex === 0 && edge.referenceStatementIndex === 1 && edge.action === 'read')).toBe(true);
        expect(avcEdges.some(edge => edge.definitionStatementIndex === 0 && edge.referenceStatementIndex === 2 && edge.action === 'drop')).toBe(true);
    });

    it('detects unused CTE and alias symbols', () => {
        const sql = `WITH USED_CTE AS (SELECT 1 AS ID), UNUSED_CTE AS (SELECT 2 AS ID)
SELECT * FROM USED_CTE U;`;

        const analysis = analyzeSqlScriptFlow(sql);

        expect(
            analysis.unusedSymbols.some(symbol => symbol.kind === 'cte' && symbol.name.toUpperCase() === 'UNUSED_CTE')
        ).toBe(true);
        expect(
            analysis.unusedSymbols.some(symbol => symbol.kind === 'table_alias' && symbol.name.toUpperCase() === 'U')
        ).toBe(true);
    });

    it('marks single-use CTE as inline candidate', () => {
        const sql = `WITH CTE_SINGLE AS (
    SELECT 1 AS ID
)
SELECT * FROM CTE_SINGLE;`;

        const analysis = analyzeSqlScriptFlow(sql);

        expect(
            analysis.refactorCandidates.some(
                candidate => candidate.type === 'inline_cte' && candidate.cteName.toUpperCase() === 'CTE_SINGLE'
            )
        ).toBe(true);
    });
});
