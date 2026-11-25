import {
    createDatabaseCapabilities,
    findCapabilityDrift,
} from '@justybase/contracts';
import { db2AdvancedFeatures } from '../../extensions/db2/src/db2DdlGenerator';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import {
    buildDb2ExplainQuery,
    buildDb2ExplainRetrieveQuery,
    db2ExplainProvider,
    isDb2ExplainOperatorRows,
    parseDb2ExplainJson,
    renderDb2ExplainPlan,
} from '../../extensions/db2/src/db2ExplainParser';
import { parseExplainOutput } from '../views/explainPlanView';
import { analyzeExplainPlanSemantic } from '../services/tuning/explainPlanSemanticAnalyzer';

describe('Db2 EXPLAIN provider', () => {
    const operatorRows = [
        {
            OPERATOR_ID: 4,
            OPERATOR_TYPE: 'RETURN',
            TOTAL_COST: 240.5,
            STREAM_COUNT: 120,
            COLUMN_COUNT: 3,
            PARENT_ID: null,
        },
        {
            OPERATOR_ID: 3,
            OPERATOR_TYPE: 'NLJOIN',
            TOTAL_COST: 230.1,
            STREAM_COUNT: 120,
            COLUMN_COUNT: 3,
            PARENT_ID: 4,
        },
        {
            OPERATOR_ID: 2,
            OPERATOR_TYPE: 'TBSCAN',
            OBJECT_SCHEMA: 'JBL_LIVE',
            OBJECT_NAME: 'JBL_ORDERS',
            TOTAL_COST: 190.4,
            STREAM_COUNT: 1000,
            COLUMN_COUNT: 4,
            PARENT_ID: 3,
        },
        {
            OPERATOR_ID: 1,
            OPERATOR_TYPE: 'IXSCAN',
            OBJECT_SCHEMA: 'JBL_LIVE',
            OBJECT_NAME: 'JBL_CUSTOMERS_PK',
            TOTAL_COST: 4.2,
            STREAM_COUNT: 12,
            COLUMN_COUNT: 2,
            PARENT_ID: 3,
        },
    ];

    it('builds the EXPLAIN and retrieval statements', () => {
        expect(db2ExplainProvider.buildQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toBe(
            buildDb2ExplainQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1'),
        );
        expect(db2ExplainProvider.buildRetrieveQuery?.()).toBe(buildDb2ExplainRetrieveQuery());

        const retrieve = buildDb2ExplainRetrieveQuery();
        expect(retrieve).toContain('EXPLAIN_OPERATOR');
        expect(retrieve).toContain('EXPLAIN_STREAM');
        expect(retrieve).toContain('AS PARENT_ID');
        expect(retrieve).toContain('OUT.SOURCE_ID = O.OPERATOR_ID');
        // Only the current user's newest request: EXPLAIN_* is shared by every
        // session, so an unfiltered MAX(EXPLAIN_TIME) can return another user's plan.
        expect(retrieve).toContain('O.EXPLAIN_REQUESTER = CURRENT USER');
        expect(retrieve).toContain('I.EXPLAIN_REQUESTER = CURRENT USER');
    });

    it('recognises flat EXPLAIN_OPERATOR rows as a plan payload', () => {
        expect(isDb2ExplainOperatorRows(operatorRows)).toBe(true);
        expect(isDb2ExplainOperatorRows([])).toBe(false);
        expect(isDb2ExplainOperatorRows([{ OPERATOR_TYPE: 'RETURN' }])).toBe(false);
        expect(isDb2ExplainOperatorRows({ plan: {} })).toBe(false);
    });

    it('rebuilds the plan tree from PARENT_ID links', () => {
        const plan = parseDb2ExplainJson(operatorRows);

        expect(plan.root.operatorType).toBe('RETURN');
        expect(plan.root.totalCost).toBe(240.5);

        const join = plan.root.children[0];
        expect(join.operatorType).toBe('NLJOIN');
        expect(join.children.map(node => node.operatorType)).toEqual(['TBSCAN', 'IXSCAN']);

        const scan = join.children[0];
        expect(scan.objectSchema).toBe('JBL_LIVE');
        expect(scan.objectName).toBe('JBL_ORDERS');
        expect(scan.columnCount).toBe(4);
    });

    it('keeps every operator reachable when PARENT_ID is missing', () => {
        const withoutParents = operatorRows.map(row => ({ ...row, PARENT_ID: null }));
        const plan = parseDb2ExplainJson(withoutParents);

        const collected: string[] = [];
        const stack = [plan.root];
        while (stack.length > 0) {
            const node = stack.pop()!;
            collected.push(node.operatorType);
            stack.push(...node.children);
        }

        expect(collected.sort()).toEqual(['IXSCAN', 'NLJOIN', 'RETURN', 'TBSCAN']);
    });

    it('renders the shared explain-text shape used by the plan webview', () => {
        const rendered = renderDb2ExplainPlan(parseDb2ExplainJson(operatorRows));

        expect(rendered).toContain('Total Cost: 240.50');
        expect(rendered).toMatch(/RETURN \(cost=240\.50\.\.240\.50 rows=120 width=3 conf=/);
        expect(rendered).toMatch(/TBSCAN table "JBL_LIVE\.JBL_ORDERS"/);
        // Child indentation drives the shared tree parser (3 spaces per level).
        expect(rendered).toContain('\n   NLJOIN');
        expect(rendered).toContain('\n      TBSCAN');
    });

    it('feeds the shared Explain Plan webview parser', () => {
        const rendered = db2ExplainProvider.normalizeOutput?.(JSON.stringify(operatorRows)) ?? '';
        const parsed = parseExplainOutput(rendered);

        // The shared parser splits a root from indented children.
        expect(parsed.nodes).toHaveLength(1);
        expect(parsed.nodes[0]?.type).toBe('RETURN');
        expect(parsed.nodes[0]?.children[0]?.type).toBe('NLJOIN');
        expect(parsed.nodes[0]?.children[0]?.children).toHaveLength(2);
        expect(parsed.nodes[0]?.children[0]?.children[0]?.table).toBe('JBL_LIVE.JBL_ORDERS');
        expect(parsed.totalCost).toBe(240.5);
    });

    it('feeds the shared semantic analyzer used by the AI tools', () => {
        const rendered = db2ExplainProvider.normalizeOutput?.(JSON.stringify(operatorRows)) ?? '';
        const analysis = analyzeExplainPlanSemantic(rendered);

        expect(analysis.summary.nodeCount).toBe(4);
        expect(analysis.summary.edgeCount).toBe(3);
        expect(analysis.summary.parseCoverage.matchedLines).toBe(4);
    });

    it('normalizes retrieved rows into plan text and passes text through', () => {
        expect(db2ExplainProvider.normalizeOutput?.('plain text output')).toBe('plain text output');

        const normalized = db2ExplainProvider.normalizeOutput?.(JSON.stringify(operatorRows));
        expect(normalized).toContain('NLJOIN');
        expect(normalized).toContain('Total Cost:');
    });

    it('explains how to provision EXPLAIN tables on catalog errors', () => {
        const hint = db2ExplainProvider.formatError?.('SQL0204N  "DB2INST1.EXPLAIN_OPERATOR" is an undefined name. SQLSTATE=42704');
        expect(hint).toContain('EXPLAIN.DDL');

        const privileges = db2ExplainProvider.formatError?.('SQL0551N  The statement failed because the authorization ID does not have the required privilege.');
        expect(privileges).toContain('EXPLAIN tables');

        expect(db2ExplainProvider.formatError?.('SQL0805N package not found')).toBeUndefined();
    });

    it('advertises EXPLAIN only because the provider exists', () => {
        expect(db2Dialect.capabilities.supportsExplainPlan).toBe(true);
        expect(db2Dialect.capabilities.supportsExplainGraph).toBe(true);
        expect(db2Dialect.advancedFeatures?.explain).toBe(db2ExplainProvider);

        const drift = findCapabilityDrift(
            createDatabaseCapabilities(db2Dialect.capabilities),
            db2AdvancedFeatures,
        );
        expect(drift.missingProvider).toEqual([]);
        expect(drift.missingFlag).toEqual([]);
    });
});
