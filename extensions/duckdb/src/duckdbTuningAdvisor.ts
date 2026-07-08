import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import { isDuckDbExplainJson, parseDuckDbExplainJson, flattenNodes, type DuckDbExplainNode } from './duckdbExplainParser';

interface RuleContext {
    sql: string;
    nodes: DuckDbExplainNode[];
    rootCardinality: number;
    totalTimingMs?: number;
}

const SEQ_SCAN_ROW_THRESHOLD = 50_000;
const SEQ_SCAN_CRITICAL_THRESHOLD = 250_000;
const CROSS_PRODUCT_WARNING_ROWS = 25_000;
const CROSS_PRODUCT_CRITICAL_ROWS = 100_000;
const HIGH_CARDINALITY_WARNING = 100_000;
const HIGH_CARDINALITY_CRITICAL = 1_000_000;
const ROW_MISESTIMATE_FACTOR = 10;
const SLOW_QUERY_INFO_MS = 500;
const SLOW_QUERY_WARNING_MS = 2_000;

function isSequentialScan(node: DuckDbExplainNode): boolean {
    return /seq.*scan|table.*scan/i.test(node.nodeType);
}

function isCrossProductOrNestedLoop(node: DuckDbExplainNode): boolean {
    return /cross.*product|nested.*loop/i.test(node.nodeType);
}

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function extractContext(input: DatabaseTuningAdvisorInput): RuleContext {
    if (!input.explainPlanText || !isDuckDbExplainJson(input.explainPlanText)) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCardinality: 0,
        };
    }

    const plan = parseDuckDbExplainJson(input.explainPlanText);

    return {
        sql: input.sql || '',
        nodes: flattenNodes(plan.root),
        rootCardinality: plan.root.estimatedCardinality,
        totalTimingMs: plan.totalTimingMs,
    };
}

export class DuckDbTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addSequentialScanRecommendation(context, recommendations);
        this.addCrossProductRecommendation(context, recommendations);
        this.addHighCardinalityRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);
        this.addSlowQueryRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'DKTA-001',
            title: 'Avoid SELECT * on DuckDB analytical workloads',
            summary: 'Selecting every column reads unnecessary data from columnar storage and prevents projection pushdown.',
            severity: 'warning',
            confidence: clampConfidence(0.76),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run EXPLAIN to confirm reduced I/O from columnar projection pushdown.',
            ],
            evidence: [
                {
                    source: 'sql_analysis',
                    summary: 'Query contains SELECT *.',
                },
            ],
        });
    }

    private addSequentialScanRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => isSequentialScan(node) && node.estimatedCardinality >= SEQ_SCAN_ROW_THRESHOLD,
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.estimatedCardinality >= SEQ_SCAN_CRITICAL_THRESHOLD;

        addRecommendation(output, {
            id: 'DKTA-002',
            title: 'Large sequential scan detected',
            summary: `${candidate.nodeType} estimates ${Math.round(candidate.estimatedCardinality).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.84),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Add filters to reduce the scanned row count.',
                'Consider partitioning or indexing strategies to limit full-table scans.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.estimatedCardinality,
                    details: candidate.tableName,
                },
            ],
        });
    }

    private addCrossProductRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => isCrossProductOrNestedLoop(node) && node.estimatedCardinality >= CROSS_PRODUCT_WARNING_ROWS,
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.estimatedCardinality >= CROSS_PRODUCT_CRITICAL_ROWS;

        addRecommendation(output, {
            id: 'DKTA-003',
            title: 'Cross product or nested loop join on large cardinality',
            summary: `${candidate.nodeType} estimates ${Math.round(candidate.estimatedCardinality).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.85),
            risk: 'high',
            actions: [
                'Verify join predicates are correct and selective.',
                'Consider rewriting the query to avoid cross-product joins or add explicit join conditions.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.estimatedCardinality,
                },
            ],
        });
    }

    private addHighCardinalityRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.rootCardinality < HIGH_CARDINALITY_WARNING) {
            return;
        }

        const isCritical = context.rootCardinality >= HIGH_CARDINALITY_CRITICAL;

        addRecommendation(output, {
            id: 'DKTA-004',
            title: 'High estimated cardinality at root',
            summary: `Root plan node estimates ${Math.round(context.rootCardinality).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.78),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Add WHERE clauses or LIMIT to reduce the result set.',
                'Review aggregation and grouping to minimize output cardinality.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Root DuckDB plan cardinality.',
                    value: context.rootCardinality,
                },
            ],
        });
    }

    private addRowEstimateRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => {
            if (node.actualRows === undefined || node.estimatedCardinality <= 0) {
                return false;
            }

            const larger = Math.max(node.actualRows, node.estimatedCardinality);
            const smaller = Math.max(1, Math.min(node.actualRows, node.estimatedCardinality));
            return larger / smaller >= ROW_MISESTIMATE_FACTOR;
        });

        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'DKTA-005',
            title: 'Cardinality estimate diverges from actual rows',
            summary: `${candidate.nodeType} estimated ${Math.round(candidate.estimatedCardinality).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.90),
            risk: 'medium',
            actions: [
                'Refresh table statistics so the optimizer has accurate cardinality estimates.',
                'Check for data skew or correlated predicates that may mislead the planner.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.actualRows ?? candidate.estimatedCardinality,
                },
            ],
        });
    }

    private addSlowQueryRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.totalTimingMs === undefined || context.totalTimingMs < SLOW_QUERY_INFO_MS) {
            return;
        }

        const isWarning = context.totalTimingMs >= SLOW_QUERY_WARNING_MS;

        addRecommendation(output, {
            id: 'DKTA-006',
            title: 'Slow query execution',
            summary: `Query execution took ${context.totalTimingMs.toFixed(1)} ms.`,
            severity: isWarning ? 'warning' : 'info',
            confidence: clampConfidence(0.72),
            risk: isWarning ? 'medium' : 'low',
            actions: [
                'Identify the most expensive operators in the EXPLAIN ANALYZE output.',
                'Compare execution time before and after applying query optimizations.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Total execution timing reported by DuckDB.',
                    value: context.totalTimingMs,
                },
            ],
        });
    }
}

export const duckdbTuningAdvisor: DatabaseTuningAdvisor = new DuckDbTuningAdvisor();
