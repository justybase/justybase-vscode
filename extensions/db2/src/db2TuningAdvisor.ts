import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import {
    isDb2ExplainJson,
    parseDb2ExplainJson,
    type Db2ExplainNode,
} from './db2ExplainParser';

interface RuleContext {
    sql: string;
    nodes: Db2ExplainNode[];
    rootCost: number;
}

const TBSCAN_ROW_THRESHOLD = 50_000;
const TBSCAN_CRITICAL_THRESHOLD = 250_000;
const NLJOIN_WARNING_ROWS = 25_000;
const NLJOIN_CRITICAL_ROWS = 100_000;
const HIGH_COST_WARNING = 10_000;
const HIGH_COST_CRITICAL = 100_000;
const SORT_ROW_THRESHOLD = 100_000;
const ROW_MISESTIMATE_FACTOR = 10;

function flattenNodes(root: Db2ExplainNode): Db2ExplainNode[] {
    const nodes: Db2ExplainNode[] = [];
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
    if (!input.explainPlanText || !isDb2ExplainJson(input.explainPlanText)) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }

    const plan = parseDb2ExplainJson(input.explainPlanText);

    return {
        sql: input.sql || '',
        nodes: flattenNodes(plan.root),
        rootCost: plan.totalCost,
    };
}

export class Db2TuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addTableScanRecommendation(context, recommendations);
        this.addNestedLoopRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addSortRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'DB2TA-001',
            title: 'Avoid SELECT * in repeatable Db2 workloads',
            summary: 'Selecting all columns increases I/O and prevents index-only access paths.',
            severity: 'warning',
            confidence: clampConfidence(0.76),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run EXPLAIN to confirm reduced cost after column pruning.',
            ],
            evidence: [
                {
                    source: 'sql_analysis',
                    summary: 'Query contains SELECT *.',
                },
            ],
        });
    }

    private addTableScanRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /TBSCAN/i.test(node.operatorType) && node.estimatedRows >= TBSCAN_ROW_THRESHOLD
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.estimatedRows >= TBSCAN_CRITICAL_THRESHOLD;

        addRecommendation(output, {
            id: 'DB2TA-002',
            title: 'Table scan on large table',
            summary: `${candidate.operatorType} estimates ${Math.round(candidate.estimatedRows).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.84),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Review index coverage for predicates used in this scan.',
                'Consider adding indexes to reduce the number of scanned rows.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operatorType,
                    value: candidate.estimatedRows,
                    details: candidate.objectName,
                },
            ],
        });
    }

    private addNestedLoopRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /NLJOIN/i.test(node.operatorType) && node.estimatedRows >= NLJOIN_WARNING_ROWS
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.estimatedRows >= NLJOIN_CRITICAL_ROWS;

        addRecommendation(output, {
            id: 'DB2TA-003',
            title: 'Nested loop join on high row count',
            summary: `${candidate.operatorType} estimates ${Math.round(candidate.estimatedRows).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.86),
            risk: 'high',
            actions: [
                'Validate join predicates and available indexes on the inner side of the loop.',
                'Consider whether a hash join or merge join rewrite would reduce repeated probes.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operatorType,
                    value: candidate.estimatedRows,
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
            id: 'DB2TA-004',
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
                    summary: 'Root Db2 plan cost.',
                    value: context.rootCost,
                },
            ],
        });
    }

    private addSortRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => /SORT/i.test(node.operatorType) && node.estimatedRows >= SORT_ROW_THRESHOLD
        );
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'DB2TA-005',
            title: 'Sort operation detected with high cardinality',
            summary: `${candidate.operatorType} estimates ${Math.round(candidate.estimatedRows).toLocaleString()} rows to sort.`,
            severity: 'warning',
            confidence: clampConfidence(0.78),
            risk: 'medium',
            actions: [
                'Review whether ORDER BY is necessary or can be deferred to the application layer.',
                'Check if an index can provide the required sort order to avoid an explicit sort.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operatorType,
                    value: candidate.estimatedRows,
                },
            ],
        });
    }

    private addRowEstimateRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => {
            if (node.actualRows === undefined || node.estimatedRows <= 0) {
                return false;
            }

            const larger = Math.max(node.actualRows, node.estimatedRows);
            const smaller = Math.max(1, Math.min(node.actualRows, node.estimatedRows));
            return larger / smaller >= ROW_MISESTIMATE_FACTOR;
        });

        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'DB2TA-006',
            title: 'Row estimate diverges from actual rows',
            summary: `${candidate.operatorType} estimated ${Math.round(candidate.estimatedRows).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.90),
            risk: 'medium',
            actions: [
                'Run RUNSTATS on the involved tables to refresh optimizer statistics.',
                'Review predicates and data skew that may invalidate cardinality estimates.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.operatorType,
                    value: candidate.actualRows ?? candidate.estimatedRows,
                },
            ],
        });
    }
}

export const db2TuningAdvisor: DatabaseTuningAdvisor = new Db2TuningAdvisor();
