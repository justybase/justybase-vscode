import * as vscode from 'vscode';
import { parseExplainOutput, ExplainPlanView, calculateCostDistribution, getCostHeatmapColor, getCostIntensity, generateTuningHints } from '../views/explainPlanView';

jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: jest.fn(),
        showInformationMessage: jest.fn()
    },
    env: {
        clipboard: { writeText: jest.fn() }
    },
    ViewColumn: { One: 1, Beside: 2 },
    Uri: {
        joinPath: jest.fn((...parts: unknown[]) => ({ path: parts.map(p => String(p)).join('/') }))
    }
}));

function createPanelMock() {
    let receiveMessageHandler: ((message: { command: string }) => void) | undefined;
    const webview = {
        cspSource: 'vscode-resource:',
        html: '',
        asWebviewUri: jest.fn((uri: { path?: string }) => `webview:${uri.path ?? ''}`),
        onDidReceiveMessage: jest.fn((handler: (message: { command: string }) => void) => {
            receiveMessageHandler = handler;
            return { dispose: jest.fn() };
        })
    };
    const panel = {
        title: '',
        webview,
        onDidDispose: jest.fn((_handler: () => void, _ctx?: unknown, disposables?: { dispose: () => void }[]) => {
            if (disposables) disposables.push({ dispose: jest.fn() });
            return { dispose: jest.fn() };
        }),
        dispose: jest.fn()
    };
    return { panel, getReceiveMessageHandler: () => receiveMessageHandler };
}

describe('views/explainPlanView', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should parse explain output tree and detect warnings', () => {
        const text = `NOTICE: QUERY PLAN
PLANTEXT:
Sequential Scan table "BIGTAB" (cost=1..20000000 rows=600000 width=16 conf=0)
   Nested Loop (cost=2..20000000000 rows=200000 width=32 conf=50)`;

        const parsed = parseExplainOutput(text);

        expect(parsed.nodes).toHaveLength(2);
        expect(parsed.nodes[0].children).toHaveLength(0);
        expect(parsed.totalCost).toBe(20000000000);
        expect(parsed.warnings.length).toBeGreaterThan(0);
        expect(parsed.warnings.some(w => w.type === 'critical')).toBe(true);
    });

    it('should parse empty or non-matching plan safely', () => {
        const parsed = parseExplainOutput('NOTICE: QUERY PLAN\nPLANTEXT:\nUnknown line');
        expect(parsed.nodes).toEqual([]);
        expect(parsed.totalCost).toBe(0);
        expect(parsed.warnings).toEqual([]);
    });

    it('should parse shared explain lines with qualified table names', () => {
        const parsed = parseExplainOutput(
            'PLANTEXT:\nTable scan table "analytics.orders" (cost=1..100 rows=1000 width=32 conf=1)',
        );

        expect(parsed.nodes).toHaveLength(1);
        expect(parsed.nodes[0]?.table).toBe('analytics.orders');
    });

    it('should render explain panel and handle copy action', () => {
        const { panel, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        const plan = parseExplainOutput(
            'PLANTEXT:\nSequential Scan table "T1" (cost=1..10 rows=1 width=8 conf=100)'
        );
        ExplainPlanView.createOrShow({} as vscode.Uri, plan, 'SELECT <x> & y');

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'netezza.explainPlan',
            'Query Execution Plan',
            1,
            expect.objectContaining({ enableScripts: true })
        );
        expect(panel.webview.html).toContain('Query Execution Plan');
        expect(panel.webview.html).toContain('SELECT &lt;x&gt; &amp; y');

        const handler = getReceiveMessageHandler();
        expect(handler).toBeDefined();
        handler!({ command: 'copyPlan' });
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(plan.rawText);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Plan copied to clipboard');
    });

    describe('FEAT-02: Explain Plan UX 2.0', () => {
        it('should calculate cost distribution correctly', () => {
            const costs = [100, 200, 300, 400, 500];
            const dist = calculateCostDistribution(costs);
            
            expect(dist.minCost).toBe(100);
            expect(dist.maxCost).toBe(500);
            expect(dist.avgCost).toBe(300);
            expect(dist.medianCost).toBe(300);
        });

        it('should handle empty cost distribution', () => {
            const dist = calculateCostDistribution([]);
            
            expect(dist.minCost).toBe(0);
            expect(dist.maxCost).toBe(0);
            expect(dist.avgCost).toBe(0);
            expect(dist.medianCost).toBe(0);
        });

        it('should return heatmap colors based on cost distribution', () => {
            const distribution = { minCost: 0, maxCost: 1000, avgCost: 500, medianCost: 500 };
            
            // Low cost (green)
            expect(getCostHeatmapColor(100, distribution)).toBe('#27ae60');
            
            // Medium cost (yellow/orange)
            expect(getCostHeatmapColor(400, distribution)).toBe('#f39c12');
            
            // High cost (red)
            expect(getCostHeatmapColor(900, distribution)).toBe('#e74c3c');
        });

        it('should return default color for equal costs', () => {
            const distribution = { minCost: 100, maxCost: 100, avgCost: 100, medianCost: 100 };
            expect(getCostHeatmapColor(100, distribution)).toBe('#3498db');
        });

        it('should return correct cost intensity classes', () => {
            const distribution = { minCost: 0, maxCost: 1000, avgCost: 500, medianCost: 500 };
            
            expect(getCostIntensity(100, distribution)).toBe('cost-low');
            expect(getCostIntensity(450, distribution)).toBe('cost-medium');
            expect(getCostIntensity(650, distribution)).toBe('cost-high');
            expect(getCostIntensity(850, distribution)).toBe('cost-critical');
        });

        it('should generate tuning hints for full scans on large tables', () => {
            const nodes = [{
                id: 1,
                type: 'Sequential Scan',
                table: 'LARGE_TABLE',
                alias: undefined,
                cost: { start: 0, end: 1000 },
                rows: 200000,
                width: 16,
                confidence: 50,
                indent: 0,
                children: [],
                raw: 'test',
                warnings: [],
                projections: [],
                restrictions: [],
                nodeDetails: []
            }];

            const hints = generateTuningHints(nodes);
            
            expect(hints.length).toBeGreaterThan(0);
            expect(hints[0].severity).toBe('warning');
            expect(hints[0].message).toContain('Full table scan');
            expect(hints[0].recommendation).toContain('DISTRIBUTE ON');
        });

        it('should detect broadcast/fabric movement as critical warning', () => {
            const text = `NOTICE: QUERY PLAN
PLANTEXT:
Broadcast Motion (cost=10..900 rows=100000 width=32 conf=80)`;

            const parsed = parseExplainOutput(text);

            expect(parsed.warnings.some(w => w.message.includes('Broadcast/Fabric data movement'))).toBe(true);
            expect(parsed.warnings.some(w => w.type === 'critical')).toBe(true);
        });

        it('should generate critical hints for nested loops with many rows', () => {
            const nodes = [{
                id: 1,
                type: 'Nested Loop',
                table: undefined,
                alias: undefined,
                cost: { start: 0, end: 5000 },
                rows: 100000,
                width: 16,
                confidence: 50,
                indent: 0,
                children: [],
                raw: 'test',
                warnings: [],
                projections: [],
                restrictions: [],
                nodeDetails: []
            }];

            const hints = generateTuningHints(nodes);
            
            const nestedLoopHint = hints.find(h => h.message.includes('Nested Loop'));
            expect(nestedLoopHint).toBeDefined();
            expect(nestedLoopHint!.severity).toBe('critical');
        });

        it('should parse plan with cost distribution', () => {
            const text = `NOTICE: QUERY PLAN
PLANTEXT:
Sequential Scan table "T1" (cost=1..100 rows=100 width=16 conf=50)
   Hash Join (cost=100..1000 rows=1000 width=32 conf=75)
      Index Scan table "T2" (cost=1..50 rows=50 width=16 conf=90)`;

            const parsed = parseExplainOutput(text);
            
            expect(parsed.costDistribution).toBeDefined();
            expect(parsed.costDistribution.minCost).toBe(1);
            expect(parsed.costDistribution.maxCost).toBe(1000);
            expect(parsed.costDistribution.avgCost).toBeGreaterThan(0);
        });

        it('should include nested node costs in distribution', () => {
            const text = `NOTICE: QUERY PLAN
PLANTEXT:
Hash Join (cost=1..100 rows=100 width=16 conf=50)
   Sequential Scan table "BIG_CHILD" (cost=1..9000 rows=1000 width=16 conf=50)`;

            const parsed = parseExplainOutput(text);

            expect(parsed.costDistribution.maxCost).toBe(9000);
        });

        it('should render interactive graph controls in HTML output', () => {
            const { panel } = createPanelMock();
            (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

            const plan = parseExplainOutput(
                'PLANTEXT:\nSequential Scan table "T1" (cost=1..100 rows=100 width=8 conf=50)'
            );
            ExplainPlanView.createOrShow({} as vscode.Uri, plan, 'SELECT 1');

            // Check for new FEAT-02 elements
            expect(panel.webview.html).toContain('pipeline-node');
            expect(panel.webview.html).toContain('cost-legend');
            expect(panel.webview.html).toContain('toggleHeatmapBtn');
            expect(panel.webview.html).toContain('Cost Heatmap');
            expect(panel.webview.html).toContain('planGraphViewport');
            expect(panel.webview.html).toContain('zoomInBtn');
            expect(panel.webview.html).toContain('fitViewBtn');
        });
    });
});

