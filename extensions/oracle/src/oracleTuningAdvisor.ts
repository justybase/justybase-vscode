import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import {
    isOracleExplainJson,
    parseOracleExplainJson,
    type OracleExplainNode,
} from './oracleExplainParser';

interface RuleContext {
    sql: string;
    nodes: OracleExplainNode[];
    rootCost: number;
}

const FULL_SCAN_ROW_THRESHOLD = 50_000;
const FULL_SCAN_CRITICAL_THRESHOLD = 250_000;
const NESTED_LOOP_WARNING_ROWS = 25_000;
const NESTED_LOOP_CRITICAL_ROWS = 100_000;
const HIGH_COST_WARNING = 10_000;
const HIGH_COST_CRITICAL = 100_000;
const ROW_MISESTIMATE_FACTOR = 10;

function flattenNodes(root: OracleExplainNode): OracleExplainNode[] {
    const nodes: OracleExplainNode[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        nodes.push(current);
        for (let index = current.children.length - 1; index >= 0; index--) {
            stack.push(current.children[index]);
        }
    }

    return nodes;
}

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function extractContext(input: DatabaseTuningAdvisorInput): RuleContext {
    if (!input.explainPlanText || !isOracleExplainJson(input.explainPlanText)) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }

    const plan = parseOracleExplainJson(input.explainPlanText);

    return {
        sql: input.sql || '',
        nodes: flattenNodes(plan.root),
        rootCost: plan.root.cost ?? 0,
    };
}

class OracleTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addFullScanRecommendation(context, recommendations);
        this.addNestedLoopRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addCartesianJoinRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);
        this.addSortHashMemoryRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'ORTA-001',
            title: 'Avoid SELECT * in Oracle production queries',
            summary: 'Selecting all columns increases I/O, network transfer, and can prevent index-only access paths.',
            severity: 'warning',
            confidence: clampConfidence(0.75),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run EXPLAIN PLAN to confirm reduced cost after narrowing the column list.',
            ],
            evidence: [
                {
                    source: 'sql_analysis',
                    summary: 'Query contains SELECT *.',
                },
            ],
        });
    }

    private addFullScanRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /TABLE ACCESS/i.test(node.operation) && /FULL/i.test(node.options ?? '') && node.cardinality >= FULL_SCAN_ROW_THRESHOLD,
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.cardinality >= FULL_SCAN_CRITICAL_THRESHOLD;

        addRecommendation(output, {
            id: 'ORTA-002',
            title: 'Full table scan on large object',
            summary: `TABLE ACCESS FULL on ${candidate.objectName ?? 'unknown'} estimates ${Math.round(candidate.cardinality).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.85),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Review index coverage for the WHERE clause predicates.',
                'Check whether filter predicates can leverage an existing or new index.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: `${candidate.operation} ${candidate.options ?? ''}`.trim(),
                    value: candidate.cardinality,
                    details: candidate.filter,
                },
            ],
        });
    }

    private addNestedLoopRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /NESTED LOOPS/i.test(node.operation) && node.cardinality >= NESTED_LOOP_WARNING_ROWS,
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.cardinality >= NESTED_LOOP_CRITICAL_ROWS;

        addRecommendation(output, {
            id: 'ORTA-003',
            title: 'Nested loops join on high cardinality',
            summary: `NESTED LOOPS estimates ${Math.round(candidate.cardinality).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.86),
            risk: 'high',
            actions: [
                'Validate join predicates and available indexes on the inner side of the loop.',
                'Consider whether a hash join or sort-merge join hint would reduce repeated probes.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operation,
                    value: candidate.cardinality,
                },
            ],
        });
    }

    private addHighCostRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.rootCost < HIGH_COST_WARNING) {
            return;
        }

        const isCritical = context.rootCost >= HIGH_COST_CRITICAL;

        addRecommendation(output, {
            id: 'ORTA-004',
            title: 'High optimizer cost',
            summary: `Root plan cost is ${context.rootCost.toLocaleString()}.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.80),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Inspect the highest-cost operators first.',
                'Reduce scanned rows, unnecessary sorts, and repeated join probes.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Root Oracle plan cost.',
                    value: context.rootCost,
                },
            ],
        });
    }

    private addCartesianJoinRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /MERGE JOIN/i.test(node.operation) && /CARTESIAN/i.test(node.options ?? ''),
        );
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'ORTA-005',
            title: 'Cartesian join detected',
            summary: `MERGE JOIN CARTESIAN estimates ${Math.round(candidate.cardinality).toLocaleString()} rows.`,
            severity: 'critical',
            confidence: clampConfidence(0.92),
            risk: 'high',
            actions: [
                'Verify that all intended join conditions are present in the query.',
                'If the Cartesian product is intentional, document it and consider row-count constraints.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: `${candidate.operation} ${candidate.options ?? ''}`.trim(),
                    value: candidate.cardinality,
                },
            ],
        });
    }

    private addRowEstimateRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => {
            if (node.actualRows === undefined || node.cardinality <= 0) {
                return false;
            }

            const larger = Math.max(node.actualRows, node.cardinality);
            const smaller = Math.max(1, Math.min(node.actualRows, node.cardinality));
            return larger / smaller >= ROW_MISESTIMATE_FACTOR;
        });

        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'ORTA-006',
            title: 'Row estimate diverges from actual rows',
            summary: `${candidate.operation} estimated ${Math.round(candidate.cardinality).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.89),
            risk: 'medium',
            actions: [
                'Gather fresh statistics with DBMS_STATS.GATHER_TABLE_STATS on the involved tables.',
                'Review predicates and data skew that may invalidate histogram estimates.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operation,
                    value: candidate.actualRows ?? candidate.cardinality,
                },
            ],
        });
    }

    private addSortHashMemoryRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => /SORT|HASH/i.test(node.operation));
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'ORTA-007',
            title: 'Sort or hash operation may consume significant memory',
            summary: `${candidate.operation} ${candidate.options ?? ''} estimates ${Math.round(candidate.cardinality).toLocaleString()} rows.`.trim(),
            severity: 'info',
            confidence: clampConfidence(0.65),
            risk: 'low',
            actions: [
                'Review PGA_AGGREGATE_TARGET and SORT_AREA_SIZE settings for the workload.',
                'Consider adding indexes to avoid sorts where possible.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operation,
                    value: candidate.cardinality,
                },
            ],
        });
    }
}

export const oracleTuningAdvisor: DatabaseTuningAdvisor = new OracleTuningAdvisor();
