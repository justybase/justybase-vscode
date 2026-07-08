import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import {
    isMsSqlExplainJson,
    parseMsSqlExplainJson,
    type MsSqlExplainNode,
} from './mssqlExplainParser';

interface RuleContext {
    sql: string;
    nodes: MsSqlExplainNode[];
    rootSubtreeCost: number;
}

const FULL_SCAN_ROW_THRESHOLD = 50_000;
const FULL_SCAN_CRITICAL_THRESHOLD = 250_000;
const HIGH_COST_WARNING = 10;
const HIGH_COST_CRITICAL = 100;
const SORT_HIGH_CARDINALITY_THRESHOLD = 100_000;
const ROW_MISESTIMATE_FACTOR = 10;

function flattenNodes(root: MsSqlExplainNode): MsSqlExplainNode[] {
    const nodes: MsSqlExplainNode[] = [];
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

function isTableOrClusteredScan(node: MsSqlExplainNode): boolean {
    return /Table Scan|Clustered Index Scan/i.test(node.physicalOp);
}

function isKeyLookup(node: MsSqlExplainNode): boolean {
    return /Key Lookup/i.test(node.physicalOp);
}

function isSortOperator(node: MsSqlExplainNode): boolean {
    return /\bSort\b/i.test(node.physicalOp);
}

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function extractContext(input: DatabaseTuningAdvisorInput): RuleContext {
    if (!input.explainPlanText || !isMsSqlExplainJson(input.explainPlanText)) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootSubtreeCost: 0,
        };
    }

    const plan = parseMsSqlExplainJson(input.explainPlanText);

    return {
        sql: input.sql || '',
        nodes: flattenNodes(plan.root),
        rootSubtreeCost: plan.totalSubtreeCost,
    };
}

export class MsSqlTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addTableScanRecommendation(context, recommendations);
        this.addKeyLookupRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addSortHighCardinalityRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);
        this.addWarningsRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'MSTA-001',
            title: 'Avoid SELECT * in SQL Server queries',
            summary: 'Selecting all columns increases I/O, prevents covering-index usage, and may pull unnecessary LOB data.',
            severity: 'warning',
            confidence: clampConfidence(0.76),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run the execution plan to confirm reduced cost after column pruning.',
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
            (node) => isTableOrClusteredScan(node) && node.estimatedRows >= FULL_SCAN_ROW_THRESHOLD,
        );
        if (!candidate) {
            return;
        }

        const isCritical = candidate.estimatedRows >= FULL_SCAN_CRITICAL_THRESHOLD;

        addRecommendation(output, {
            id: 'MSTA-002',
            title: 'Table or clustered index scan on large table',
            summary: `${candidate.physicalOp} estimates ${Math.round(candidate.estimatedRows).toLocaleString()} rows.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.85),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Create or adjust nonclustered indexes to cover the query predicates and output columns.',
                'Review WHERE clause selectivity and consider filtered indexes for skewed data.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.physicalOp,
                    value: candidate.estimatedRows,
                    details: candidate.objectName,
                },
            ],
        });
    }

    private addKeyLookupRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => isKeyLookup(node));
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MSTA-003',
            title: 'Key Lookup detected',
            summary: `Key Lookup on ${candidate.objectName ?? 'unknown object'} adds random I/O for each row from the nonclustered index seek.`,
            severity: 'info',
            confidence: clampConfidence(0.80),
            risk: 'medium',
            actions: [
                'Consider creating a covering index that includes the required output columns to eliminate the key lookup.',
                'Use INCLUDE columns in the nonclustered index definition to cover the query without widening the index key.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.physicalOp,
                    value: candidate.estimatedRows,
                    details: candidate.objectName,
                },
            ],
        });
    }

    private addHighCostRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.rootSubtreeCost < HIGH_COST_WARNING) {
            return;
        }

        const isCritical = context.rootSubtreeCost >= HIGH_COST_CRITICAL;

        addRecommendation(output, {
            id: 'MSTA-004',
            title: 'High estimated subtree cost',
            summary: `Root plan estimated subtree cost is ${context.rootSubtreeCost.toFixed(4)}.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.79),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Inspect the highest-cost operators in the plan first.',
                'Reduce scanned rows through better predicates, indexes, or query rewrites.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Root MS SQL Server estimated subtree cost.',
                    value: context.rootSubtreeCost,
                },
            ],
        });
    }

    private addSortHighCardinalityRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find(
            (node) => isSortOperator(node) && node.estimatedRows >= SORT_HIGH_CARDINALITY_THRESHOLD,
        );
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MSTA-005',
            title: 'Sort operator with high cardinality',
            summary: `Sort estimates ${Math.round(candidate.estimatedRows).toLocaleString()} rows, which may cause memory grants or tempdb spills.`,
            severity: 'warning',
            confidence: clampConfidence(0.78),
            risk: 'medium',
            actions: [
                'Add or adjust an index that provides pre-sorted output matching the ORDER BY or GROUP BY clause.',
                'Reduce the number of rows reaching the sort operator through tighter predicates.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.physicalOp,
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
            id: 'MSTA-006',
            title: 'Row estimate diverges from actual rows',
            summary: `${candidate.physicalOp} estimated ${Math.round(candidate.estimatedRows).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.90),
            risk: 'medium',
            actions: [
                'Update statistics on the involved tables with UPDATE STATISTICS or sp_updatestats.',
                'Review predicates for parameter sniffing issues or data skew that may invalidate histogram estimates.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.physicalOp,
                    value: candidate.actualRows ?? candidate.estimatedRows,
                    details: candidate.objectName,
                },
            ],
        });
    }

    private addWarningsRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => !!node.warnings);
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MSTA-007',
            title: 'Execution plan contains warnings',
            summary: `Plan warning on ${candidate.physicalOp}: ${candidate.warnings}`,
            severity: 'warning',
            confidence: clampConfidence(0.88),
            risk: 'medium',
            actions: [
                'Review plan warnings for missing indexes, implicit conversions, or excessive memory grants.',
                'Address implicit type conversions in predicates that prevent index seeks.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.physicalOp,
                    details: candidate.warnings,
                },
            ],
        });
    }
}

export const mssqlTuningAdvisor: DatabaseTuningAdvisor = new MsSqlTuningAdvisor();
