jest.unmock('chevrotain');

import { analyzeSqlQueryStructures } from '../../sqlParser';

describe('analyzeSqlQueryStructures', () => {
    it('finds extractable nested subqueries inside table sources', () => {
        const sql = `SELECT C.CUSTOMER_ID
FROM (
    SELECT O.CUSTOMER_ID, COUNT(*) AS ORDER_COUNT
    FROM SALES..ORDERS O
) ORDER_COUNTS
JOIN SALES..CUSTOMERS C ON C.CUSTOMER_ID = ORDER_COUNTS.CUSTOMER_ID;`;

        const analysis = analyzeSqlQueryStructures(sql);
        expect(analysis.extractSubqueryCandidates).toHaveLength(1);

        const candidate = analysis.extractSubqueryCandidates[0];
        expect(candidate.suggestedName).toBe('new_cte_name');
        expect(candidate.hasWithClause).toBe(false);
        expect(candidate.subqueryBodyRange.startLine).toBe(2);
        expect(candidate.subqueryBodyRange.endLine).toBe(3);
    });

    it('finds CTE materialization and temp-table inline candidates', () => {
        const sql = `WITH SALES_CTE AS (
    SELECT CUSTOMER_ID
    FROM SALES..ORDERS
)
SELECT * FROM SALES_CTE;

CREATE TEMP TABLE TMP_SALES AS
SELECT CUSTOMER_ID
FROM SALES..ORDERS;

SELECT * FROM TMP_SALES;`;

        const analysis = analyzeSqlQueryStructures(sql);

        expect(analysis.cteMaterializationCandidates).toHaveLength(1);
        expect(analysis.cteMaterializationCandidates[0].cteName).toBe('SALES_CTE');
        expect(analysis.cteMaterializationCandidates[0].cteBodyRange.startLine).toBe(1);

        expect(analysis.cteBulkMaterializationCandidates).toHaveLength(1);
        expect(analysis.cteBulkMaterializationCandidates[0].statementKind).toBe('with_select');
        expect(analysis.cteBulkMaterializationCandidates[0].hasRecursive).toBe(false);

        expect(analysis.tempTableInlineCandidates).toHaveLength(1);
        expect(analysis.tempTableInlineCandidates[0].tempTableName).toBe('TMP_SALES');
        expect(analysis.tempTableInlineCandidates[0].nextStatementKind).toBe('select');
    });

    it('does not offer temp-table inlining when the next statement does not use the temp table', () => {
        const sql = `CREATE TEMP TABLE TMP_SALES AS
SELECT CUSTOMER_ID
FROM SALES..ORDERS;

SELECT * FROM SALES..CUSTOMERS;`;

        const analysis = analyzeSqlQueryStructures(sql);
        expect(analysis.tempTableInlineCandidates).toHaveLength(0);
    });

    it('builds query flow graphs with CTE, subquery, temp-table, and base-table nodes', () => {
        const sql = `CREATE TEMP TABLE TMP_ORDERS AS
SELECT O.CUSTOMER_ID, O.ORDER_ID
FROM SALES..ORDERS O;

WITH REGION_SALES AS (
    SELECT T.CUSTOMER_ID, C.REGION
    FROM TMP_ORDERS T
    JOIN SALES..CUSTOMERS C ON C.CUSTOMER_ID = T.CUSTOMER_ID
),
FILTERED_REGION_SALES AS (
    SELECT *
    FROM (
        SELECT CUSTOMER_ID, REGION
        FROM REGION_SALES
    ) INLINE_REGION_SALES
)
SELECT *
FROM FILTERED_REGION_SALES;`;

        const analysis = analyzeSqlQueryStructures(sql);
        expect(analysis.statementFlows).toHaveLength(1);

        const flow = analysis.statementFlows[0];
        const kinds = new Set(flow.nodes.map(node => node.kind));
        expect(kinds.has('cte')).toBe(true);
        expect(kinds.has('subquery')).toBe(true);
        expect(kinds.has('temp_table')).toBe(true);
        expect(kinds.has('table')).toBe(true);

        const filteredCte = flow.nodes.find(node => node.label === 'FILTERED_REGION_SALES');
        const rootNode = flow.nodes.find(node => node.id === flow.rootNodeId);
        expect(filteredCte).toBeDefined();
        expect(rootNode).toBeDefined();
        expect(
            flow.edges.some(edge => edge.from === filteredCte!.id && edge.to === rootNode!.id)
        ).toBe(true);

        const tempTableNode = flow.nodes.find(node => node.kind === 'temp_table' && node.label.includes('TMP_ORDERS'));
        const regionSalesNode = flow.nodes.find(node => node.label === 'REGION_SALES');
        expect(tempTableNode).toBeDefined();
        expect(regionSalesNode).toBeDefined();
        expect(
            flow.edges.some(edge => edge.from === tempTableNode!.id && edge.to === regionSalesNode!.id)
        ).toBe(true);
    });
});
