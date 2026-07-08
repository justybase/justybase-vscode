export type ExplainHotspotSeverity = 'critical' | 'warning' | 'info';

export type ExplainHotspotRisk = 'low' | 'medium' | 'high';

export interface ExplainPlanSemanticNode {
    id: number;
    depth: number;
    operator: string;
    table?: string;
    costStart: number;
    costEnd: number;
    rows: number;
    width: number;
    confidence: number;
    raw: string;
}

export interface ExplainPlanSemanticEdge {
    from: number;
    to: number;
    relationship: 'child';
}

export type ExplainPlanHotspotType =
    | 'data_movement'
    | 'full_scan'
    | 'nested_loop'
    | 'high_cost'
    | 'low_confidence';

export interface ExplainPlanHotspot {
    id: string;
    nodeId: number;
    type: ExplainPlanHotspotType;
    severity: ExplainHotspotSeverity;
    operator: string;
    message: string;
    recommendation: string;
}

export interface ExplainPlanSemanticSummary {
    nodeCount: number;
    edgeCount: number;
    maxDepth: number;
    rootCost: number;
    maxCost: number;
    avgCost: number;
    avgConfidence: number;
    overallRisk: ExplainHotspotRisk;
    parseCoverage: {
        matchedLines: number;
        totalLines: number;
    };
    hotspotCount: {
        critical: number;
        warning: number;
        info: number;
    };
    operatorHistogram: Record<string, number>;
}

export interface ExplainPlanSemanticAnalysis {
    rawPlan: string;
    normalizedPlan: string;
    nodes: ExplainPlanSemanticNode[];
    edges: ExplainPlanSemanticEdge[];
    hotspots: ExplainPlanHotspot[];
    summary: ExplainPlanSemanticSummary;
}

const EXPLAIN_NODE_REGEX =
    /^[\s]*(?:[lr]:\s*)?([\w][\w\s/-]*?)(?:\s+table\s+"([^"]+)")?(?:\s+\{[^}]*\})?\s*\(cost=([\d.]+)\.\.([\d.]+)\s+rows=([\d.]+)\s+width=([\d.]+)\s+conf=([\d.]+)\)/i;
const FULL_SCAN_WARNING_ROWS = 50_000;
const NESTED_LOOP_WARNING_ROWS = 50_000;
const NESTED_LOOP_CRITICAL_ROWS = 100_000;
const HIGH_COST_WARNING = 10_000_000;
const HIGH_COST_CRITICAL = 10_000_000_000;

function normalizeOperatorName(operator: string): string {
    return operator.trim().replace(/\s+/g, ' ');
}

function isDataMovementOperator(operator: string): boolean {
    return /broadcast|redistribute|fabric|motion|repartition/i.test(operator);
}

function isFullScanOperator(operator: string): boolean {
    return /sequential\s+scan|full\s+scan|table\s+scan/i.test(operator);
}

function isNestedLoopOperator(operator: string): boolean {
    return /nested\s+loop/i.test(operator);
}

function stripNoticePrefix(line: string): string {
    return line.replace(/^NOTICE:\s*/i, '');
}

function isExplainMetadataLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
        return true;
    }
    if (/^QUERY\s+(VERBOSE\s+)?PLAN:?$/i.test(trimmed)) {
        return true;
    }
    if (/^QUERY\s+VERBOSE\b/i.test(trimmed)) {
        return true;
    }
    if (/^\(xpath_/i.test(trimmed)) {
        return true;
    }
    if (/locus=/i.test(trimmed)) {
        return true;
    }
    return false;
}

function getPlanCandidateLines(planText: string): string[] {
    const allLines = planText.split('\n').map(stripNoticePrefix);
    const planTextHeaderIndex = allLines.findIndex(line => /PLANTEXT:/i.test(line));
    const candidateLines = planTextHeaderIndex >= 0 ? allLines.slice(planTextHeaderIndex + 1) : allLines;
    return candidateLines.filter(line => !isExplainMetadataLine(line));
}

function toFiniteNumber(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseNodeLine(line: string, id: number): ExplainPlanSemanticNode | undefined {
    const match = line.match(EXPLAIN_NODE_REGEX);
    if (!match) {
        return undefined;
    }

    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
    const depth = Math.max(0, Math.floor(leadingSpaces / 3));
    const operator = normalizeOperatorName(match[1]);
    const table = match[2]?.trim();

    return {
        id,
        depth,
        operator,
        table: table && table.length > 0 ? table : undefined,
        costStart: toFiniteNumber(match[3]),
        costEnd: toFiniteNumber(match[4]),
        rows: toFiniteNumber(match[5]),
        width: toFiniteNumber(match[6]),
        confidence: toFiniteNumber(match[7]),
        raw: line.trim()
    };
}

function buildEdges(nodes: ExplainPlanSemanticNode[]): ExplainPlanSemanticEdge[] {
    const edges: ExplainPlanSemanticEdge[] = [];
    const stack: ExplainPlanSemanticNode[] = [];

    for (const node of nodes) {
        while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) {
            stack.pop();
        }

        const parent = stack[stack.length - 1];
        if (parent) {
            edges.push({ from: parent.id, to: node.id, relationship: 'child' });
        }

        stack.push(node);
    }

    return edges;
}

function pushHotspot(
    hotspots: ExplainPlanHotspot[],
    node: ExplainPlanSemanticNode,
    type: ExplainPlanHotspotType,
    severity: ExplainHotspotSeverity,
    message: string,
    recommendation: string
): void {
    hotspots.push({
        id: `${type}:${node.id}`,
        nodeId: node.id,
        type,
        severity,
        operator: node.operator,
        message,
        recommendation
    });
}

function detectNodeHotspots(node: ExplainPlanSemanticNode): ExplainPlanHotspot[] {
    const hotspots: ExplainPlanHotspot[] = [];

    if (isDataMovementOperator(node.operator)) {
        pushHotspot(
            hotspots,
            node,
            'data_movement',
            'critical',
            `Data movement operator detected (${node.operator}).`,
            'Align DISTRIBUTE ON keys for join/filter columns to reduce redistribution and broadcast movement.'
        );
    }

    if (isFullScanOperator(node.operator) && node.rows >= FULL_SCAN_WARNING_ROWS) {
        pushHotspot(
            hotspots,
            node,
            'full_scan',
            'warning',
            `Full scan estimates ${Math.round(node.rows).toLocaleString()} rows.`,
            'Push selective predicates, trim projection, and verify ORGANIZE ON / zone-map friendly filters.'
        );
    }

    if (isNestedLoopOperator(node.operator) && node.rows >= NESTED_LOOP_WARNING_ROWS) {
        const severity: ExplainHotspotSeverity = node.rows >= NESTED_LOOP_CRITICAL_ROWS ? 'critical' : 'warning';
        pushHotspot(
            hotspots,
            node,
            'nested_loop',
            severity,
            `Nested loop estimates ${Math.round(node.rows).toLocaleString()} rows.`,
            'Review join predicates and distribution strategy; consider rewrite patterns that favor hash joins.'
        );
    }

    if (node.costEnd >= HIGH_COST_WARNING) {
        const severity: ExplainHotspotSeverity = node.costEnd >= HIGH_COST_CRITICAL ? 'critical' : 'warning';
        pushHotspot(
            hotspots,
            node,
            'high_cost',
            severity,
            `High estimated operator cost (${node.costEnd.toLocaleString()}).`,
            'Inspect this operator first and reduce scanned rows, redistributed data, or expensive join fan-out.'
        );
    }

    if (node.confidence === 0) {
        pushHotspot(
            hotspots,
            node,
            'low_confidence',
            'info',
            'Optimizer confidence is 0 (statistics may be stale).',
            'Run GENERATE STATISTICS on involved tables and re-run EXPLAIN to verify improved confidence.'
        );
    }

    return hotspots;
}

function dedupeHotspots(hotspots: ExplainPlanHotspot[]): ExplainPlanHotspot[] {
    const unique = new Map<string, ExplainPlanHotspot>();
    for (const hotspot of hotspots) {
        if (!unique.has(hotspot.id)) {
            unique.set(hotspot.id, hotspot);
        }
    }
    return Array.from(unique.values());
}

function getHotspotCounts(hotspots: ExplainPlanHotspot[]): { critical: number; warning: number; info: number } {
    return hotspots.reduce(
        (acc, hotspot) => {
            acc[hotspot.severity] += 1;
            return acc;
        },
        { critical: 0, warning: 0, info: 0 }
    );
}

function resolveOverallRisk(hotspotCounts: { critical: number; warning: number; info: number }): ExplainHotspotRisk {
    if (hotspotCounts.critical > 0) {
        return 'high';
    }
    if (hotspotCounts.warning > 0) {
        return 'medium';
    }
    return 'low';
}

function buildOperatorHistogram(nodes: ExplainPlanSemanticNode[]): Record<string, number> {
    const histogram: Record<string, number> = {};
    for (const node of nodes) {
        const key = node.operator.toUpperCase();
        histogram[key] = (histogram[key] || 0) + 1;
    }
    return histogram;
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
}

export function normalizeExplainPlan(planText: string): string {
    return getPlanCandidateLines(planText).join('\n');
}

export function parseExplainPlanNodes(planText: string): {
    nodes: ExplainPlanSemanticNode[];
    matchedLines: number;
    totalLines: number;
    normalizedPlan: string;
} {
    const candidateLines = getPlanCandidateLines(planText);
    const nodes: ExplainPlanSemanticNode[] = [];

    for (const line of candidateLines) {
        const node = parseNodeLine(line, nodes.length + 1);
        if (node) {
            nodes.push(node);
        }
    }

    return {
        nodes,
        matchedLines: nodes.length,
        totalLines: candidateLines.length,
        normalizedPlan: candidateLines.join('\n')
    };
}

export function analyzeExplainPlanSemantic(planText: string): ExplainPlanSemanticAnalysis {
    const parsed = parseExplainPlanNodes(planText);
    const edges = buildEdges(parsed.nodes);
    const hotspots = dedupeHotspots(parsed.nodes.flatMap(node => detectNodeHotspots(node)));
    const hotspotCount = getHotspotCounts(hotspots);

    const rootCosts = parsed.nodes.filter(node => node.depth === 0).map(node => node.costEnd);
    const allCosts = parsed.nodes.map(node => node.costEnd);
    const allConfidence = parsed.nodes.map(node => node.confidence);

    const summary: ExplainPlanSemanticSummary = {
        nodeCount: parsed.nodes.length,
        edgeCount: edges.length,
        maxDepth: parsed.nodes.reduce((maxDepth, node) => Math.max(maxDepth, node.depth), 0),
        rootCost: rootCosts.length > 0 ? Math.max(...rootCosts) : 0,
        maxCost: allCosts.length > 0 ? Math.max(...allCosts) : 0,
        avgCost: average(allCosts),
        avgConfidence: average(allConfidence),
        overallRisk: resolveOverallRisk(hotspotCount),
        parseCoverage: {
            matchedLines: parsed.matchedLines,
            totalLines: parsed.totalLines
        },
        hotspotCount,
        operatorHistogram: buildOperatorHistogram(parsed.nodes)
    };

    return {
        rawPlan: planText,
        normalizedPlan: parsed.normalizedPlan,
        nodes: parsed.nodes,
        edges,
        hotspots,
        summary
    };
}

export function collectExplainHotspotNextActions(hotspots: ExplainPlanHotspot[], limit: number = 5): string[] {
    const orderedHotspots = [...hotspots].sort((left, right) => {
        const severityWeight: Record<ExplainHotspotSeverity, number> = {
            critical: 0,
            warning: 1,
            info: 2
        };
        return severityWeight[left.severity] - severityWeight[right.severity];
    });

    const uniqueActions = Array.from(new Set(orderedHotspots.map(hotspot => hotspot.recommendation)));
    return uniqueActions.slice(0, Math.max(1, limit));
}
