jest.unmock('chevrotain');

import {
    analyzeSqlQueryStructures,
    buildCteToTempTableTransform,
    rangesIntersect,
} from '../../sqlParser';

function transformBulk(sql: string, kind: 'TEMP' | 'GLOBAL_TEMP' = 'TEMP') {
    const analysis = analyzeSqlQueryStructures(sql);
    const candidate = analysis.cteBulkMaterializationCandidates[0];
    if (!candidate) {
        return undefined;
    }
    return buildCteToTempTableTransform(
        sql,
        candidate.withRootNode,
        candidate.statementRange,
        kind,
    );
}

describe('buildCteToTempTableTransform', () => {
    it('converts nested WITH example preserving order, comments, and final SELECT', () => {
        const sql = `
WITH CTE1 AS 
(
SELECT * FROM DIMDATE
)

,CTE2 AS 
(
SELECT * FROM CTE1
)

--some comment
,CTE3 AS 
(
    WITH CTE4 AS 
    (
    SELECT * FROM DIMEMPLOYEE
    )

    ,CTE5 AS 
    (
    SELECT 2 FROM DIMEMPLOYEE
    )
    SELECT 5,* FROM CTE5
)


SELECT * FROM CTE3;
`;

        const plan = transformBulk(sql.trim());
        expect(plan).toBeDefined();
        expect(plan!.flattenedCteNames).toEqual(['CTE1', 'CTE2', 'CTE4', 'CTE5', 'CTE3']);

        const output = plan!.outputSql;
        expect(output.indexOf('CREATE TEMP TABLE CTE1')).toBeLessThan(output.indexOf('CREATE TEMP TABLE CTE2'));
        expect(output.indexOf('CREATE TEMP TABLE CTE2')).toBeLessThan(output.indexOf('CREATE TEMP TABLE CTE4'));
        expect(output.indexOf('CREATE TEMP TABLE CTE4')).toBeLessThan(output.indexOf('CREATE TEMP TABLE CTE5'));
        expect(output.indexOf('CREATE TEMP TABLE CTE5')).toBeLessThan(output.indexOf('CREATE TEMP TABLE CTE3'));
        expect(output.indexOf('CREATE TEMP TABLE CTE3')).toBeLessThan(output.indexOf('SELECT * FROM CTE3'));

        expect(output).toContain('--some comment');
        expect(output).toContain('SELECT 5,* FROM CTE5');
        expect(output).not.toContain('WITH CTE4');
        expect(output).not.toContain('WITH CTE1');
        expect(output).toMatch(/DISTRIBUTE ON RANDOM;/g);
        expect(output.match(/DISTRIBUTE ON RANDOM;/g)?.length).toBe(5);
        expect(output.trimEnd()).toMatch(/SELECT \* FROM CTE3;$/);
        expect(output).not.toMatch(/;\s*;/);
        expect(output).toContain('CREATE TEMP TABLE CTE1 AS\n(\n    SELECT * FROM DIMDATE\n)DISTRIBUTE ON RANDOM;');
    });

    it('does not leave a duplicate trailing semicolon after workspace replace', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
)
SELECT * FROM CTE1;`;
        const analysis = analyzeSqlQueryStructures(sql);
        const candidate = analysis.cteBulkMaterializationCandidates[0];
        const plan = buildCteToTempTableTransform(
            sql,
            candidate.withRootNode,
            candidate.statementRange,
            'TEMP',
        );
        expect(plan).toBeDefined();

        const replaced = sql.slice(0, plan!.replacementRange.startOffset)
            + plan!.outputSql
            + sql.slice(plan!.replacementRange.endOffset);
        expect(replaced.trimEnd()).toMatch(/SELECT \* FROM CTE1;$/);
        expect(replaced).not.toMatch(/;\s*;/);
    });

    it('formats CREATE TEMP TABLE with parentheses and indented body', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain(
            'CREATE TEMP TABLE CTE1 AS\n(\n    SELECT 1 AS VALUE\n)DISTRIBUTE ON RANDOM;',
        );
    });

    it('converts a single CTE without nesting', () => {
        const sql = `WITH SALES_CTE AS (
    SELECT CUSTOMER_ID
    FROM SALES..ORDERS
)
SELECT * FROM SALES_CTE;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.flattenedCteNames).toEqual(['SALES_CTE']);
        expect(plan!.outputSql).toContain('CREATE TEMP TABLE SALES_CTE AS');
        expect(plan!.outputSql).toContain('SELECT * FROM SALES_CTE;');
        expect(plan!.outputSql).not.toContain('WITH SALES_CTE');
    });

    it('flattens three levels of nested WITH in declaration order', () => {
        const sql = `WITH LVL1 AS (
    WITH LVL2 AS (
        WITH LVL3 AS (
            SELECT 1 AS VALUE
        )
        SELECT * FROM LVL3
    )
    SELECT * FROM LVL2
)
SELECT * FROM LVL1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.flattenedCteNames).toEqual(['LVL3', 'LVL2', 'LVL1']);
        expect(plan!.outputSql.indexOf('CREATE TEMP TABLE LVL3'))
            .toBeLessThan(plan!.outputSql.indexOf('CREATE TEMP TABLE LVL2'));
        expect(plan!.outputSql.indexOf('CREATE TEMP TABLE LVL2'))
            .toBeLessThan(plan!.outputSql.indexOf('CREATE TEMP TABLE LVL1'));
    });

    it('preserves comments inside CTE bodies', () => {
        const sql = `WITH CTE1 AS (
    -- inline comment
    SELECT 1 AS VALUE
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain('-- inline comment');
    });

    it('drops explicit CTE column lists in CREATE TEMP TABLE output', () => {
        const sql = `WITH CTE1 (A, B) AS (
    SELECT 1 AS A, 2 AS B
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain('CREATE TEMP TABLE CTE1 AS');
        expect(plan!.outputSql).not.toContain('CTE1 (A, B)');
    });

    it('handles UNION in CTE body', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
    UNION ALL
    SELECT 2 AS VALUE
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain('UNION ALL');
        expect(plan!.flattenedCteNames).toEqual(['CTE1']);
    });

    it('returns undefined for WITH RECURSIVE', () => {
        const sql = `WITH RECURSIVE CTE1 AS (
    SELECT 1 AS VALUE
    UNION ALL
    SELECT VALUE + 1 FROM CTE1 WHERE VALUE < 3
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeUndefined();
    });

    it('returns undefined when nested and outer CTE names collide', () => {
        const sql = `WITH CTE1 AS (
    WITH CTE1 AS (
        SELECT 1 AS VALUE
    )
    SELECT * FROM CTE1
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql);
        expect(plan).toBeUndefined();
    });

    it('emits CREATE GLOBAL TEMP TABLE when requested', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
)
SELECT * FROM CTE1;`;

        const plan = transformBulk(sql, 'GLOBAL_TEMP');
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain('CREATE GLOBAL TEMP TABLE CTE1 AS');
        expect(plan!.outputSql).not.toContain('CREATE TEMP TABLE CTE1 AS');
    });

    it('keeps blank lines between CREATE statements', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
),
CTE2 AS (
    SELECT 2 AS VALUE
)
SELECT * FROM CTE2;`;

        const plan = transformBulk(sql);
        expect(plan).toBeDefined();
        expect(plan!.outputSql).toContain('CREATE TEMP TABLE CTE1');
        expect(plan!.outputSql).toContain('CREATE TEMP TABLE CTE2');
        expect(plan!.outputSql.indexOf('CREATE TEMP TABLE CTE1'))
            .toBeLessThan(plan!.outputSql.indexOf('CREATE TEMP TABLE CTE2'));
    });
});

describe('rangesIntersect', () => {
    it('detects overlapping ranges', () => {
        expect(rangesIntersect({ startOffset: 10, endOffset: 20, startLine: 0, endLine: 0 }, 15, 25)).toBe(true);
        expect(rangesIntersect({ startOffset: 10, endOffset: 20, startLine: 0, endLine: 0 }, 0, 5)).toBe(false);
        expect(rangesIntersect({ startOffset: 10, endOffset: 20, startLine: 0, endLine: 0 }, 10, 20)).toBe(true);
    });
});

describe('analyzeSqlQueryStructures bulk CTE candidates', () => {
    it('finds bulk materialization candidate for nested WITH example', () => {
        const sql = `WITH CTE1 AS (SELECT 1)
,CTE2 AS (
    WITH CTE3 AS (SELECT 2)
    SELECT * FROM CTE3
)
SELECT * FROM CTE2;`;

        const analysis = analyzeSqlQueryStructures(sql);
        expect(analysis.cteBulkMaterializationCandidates).toHaveLength(1);
        expect(analysis.cteBulkMaterializationCandidates[0].hasRecursive).toBe(false);
        expect(analysis.cteBulkMaterializationCandidates[0].statementKind).toBe('with_select');
    });

    it('marks recursive WITH statements', () => {
        const sql = `WITH RECURSIVE CTE1 AS (SELECT 1) SELECT * FROM CTE1;`;
        const analysis = analyzeSqlQueryStructures(sql);
        expect(analysis.cteBulkMaterializationCandidates[0]?.hasRecursive).toBe(true);
    });
});
