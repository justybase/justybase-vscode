import {
    analyzeExplainPlanSemantic,
    collectExplainHotspotNextActions,
    normalizeExplainPlan,
    parseExplainPlanNodes
} from '../services/tuning/explainPlanSemanticAnalyzer';

const COMPLEX_PLAN = [
    'NOTICE: QUERY PLAN:',
    'PLANTEXT:',
    'Hash Join (cost=100..2000 rows=120000 width=16 conf=0)',
    '   Broadcast Motion (cost=1000..15000 rows=150000 width=32 conf=50)',
    '      Sequential Scan table "ADMIN.BIG_TABLE" (cost=100..1200 rows=80000 width=12 conf=75)',
    '   Nested Loop (cost=1500..25000000 rows=150000 width=40 conf=80)',
    '      Full Scan table "ADMIN.DIM_SMALL" (cost=10..500 rows=2000 width=20 conf=90)'
].join('\n');

describe('services/tuning/explainPlanSemanticAnalyzer', () => {
    it('normalizes explain text and parses semantic nodes', () => {
        const normalized = normalizeExplainPlan(COMPLEX_PLAN);
        const parsed = parseExplainPlanNodes(COMPLEX_PLAN);

        expect(normalized).not.toContain('QUERY PLAN');
        expect(parsed.totalLines).toBe(5);
        expect(parsed.matchedLines).toBe(5);
        expect(parsed.nodes).toHaveLength(5);

        expect(parsed.nodes[0]).toMatchObject({
            id: 1,
            depth: 0,
            operator: 'Hash Join'
        });
        expect(parsed.nodes[1]).toMatchObject({
            id: 2,
            depth: 1,
            operator: 'Broadcast Motion'
        });
        expect(parsed.nodes[2]).toMatchObject({
            operator: 'Sequential Scan',
            table: 'ADMIN.BIG_TABLE'
        });
    });

    it('builds graph, classifies hotspots, and computes risk summary', () => {
        const analysis = analyzeExplainPlanSemantic(COMPLEX_PLAN);

        expect(analysis.nodes).toHaveLength(5);
        expect(analysis.edges).toHaveLength(4);
        expect(analysis.summary).toMatchObject({
            nodeCount: 5,
            edgeCount: 4,
            overallRisk: 'high'
        });
        expect(analysis.summary.operatorHistogram).toMatchObject({
            'HASH JOIN': 1,
            'BROADCAST MOTION': 1,
            'SEQUENTIAL SCAN': 1,
            'NESTED LOOP': 1,
            'FULL SCAN': 1
        });
        expect(analysis.summary.hotspotCount.critical).toBeGreaterThan(0);
        expect(analysis.hotspots.map(hotspot => hotspot.type)).toEqual(
            expect.arrayContaining(['data_movement', 'full_scan', 'nested_loop', 'high_cost', 'low_confidence'])
        );

        const nextActions = collectExplainHotspotNextActions(analysis.hotspots, 3);
        expect(nextActions.length).toBeLessThanOrEqual(3);
        expect(new Set(nextActions).size).toBe(nextActions.length);
    });

    it('returns empty semantic graph for unparseable plan lines', () => {
        const plan = ['NOTICE: QUERY VERBOSE PLAN:', 'PLANTEXT:', 'This line is not a plan node', '(xpath_foo=1)', 'locus=dn']
            .join('\n');

        const parsed = parseExplainPlanNodes(plan);
        const analysis = analyzeExplainPlanSemantic(plan);

        expect(parsed.totalLines).toBe(1);
        expect(parsed.matchedLines).toBe(0);
        expect(analysis.nodes).toHaveLength(0);
        expect(analysis.edges).toHaveLength(0);
        expect(analysis.summary.parseCoverage).toEqual({ matchedLines: 0, totalLines: 1 });
        expect(analysis.summary.overallRisk).toBe('low');
        expect(collectExplainHotspotNextActions(analysis.hotspots)).toEqual([]);
    });
});
