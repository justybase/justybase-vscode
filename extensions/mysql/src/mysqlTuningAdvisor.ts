import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import {
    isMysqlExplainJson,
    isMysqlExplainText,
    parseMysqlExplainPlan,
    type MysqlExplainNode,
} from './mysqlExplainParser';

interface RuleContext {
    sql: string;
    nodes: MysqlExplainNode[];
    rootCost: number;
    maxActualTimeMs?: number;
}

const FULL_SCAN_ROW_THRESHOLD = 50_000;
const HIGH_COST_WARNING = 10_000;
const HIGH_COST_CRITICAL = 100_000;
const ROW_MISESTIMATE_FACTOR = 10;
const SLOW_NODE_WARNING_MS = 500;
const SLOW_NODE_CRITICAL_MS = 2_000;

function flattenNodes(root: MysqlExplainNode): MysqlExplainNode[] {
    const nodes: MysqlExplainNode[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        nodes.push(current);
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }

    return nodes;
}

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function getEstimatedRows(node: MysqlExplainNode): number {
    return Math.max(node.rowsProducedPerJoin, node.rowsExaminedPerScan);
}

function isLargeFullScan(node: MysqlExplainNode): boolean {
    const accessType = node.accessType?.trim().toUpperCase();
    return (
        (accessType === 'ALL' || /table\s+scan/i.test(node.nodeType))
        && getEstimatedRows(node) >= FULL_SCAN_ROW_THRESHOLD
    );
}

function hasPotentialIndexMiss(node: MysqlExplainNode): boolean {
    const accessType = node.accessType?.trim().toUpperCase();
    const hasJoinBuffer = typeof node.detail === 'string' && /join buffer/i.test(node.detail);
    return (
        accessType === 'ALL'
        && !node.indexName
        && (node.possibleKeys.length > 0 || hasJoinBuffer)
    );
}

function usesFilesortOrTemporaryTable(node: MysqlExplainNode): boolean {
    if (node.usingFilesort || node.usingTemporaryTable) {
        return true;
    }

    const serialized = JSON.stringify(node.raw);
    return /filesort|temporary/i.test(serialized) || /filesort|temporary/i.test(node.detail ?? '');
}

function extractContext(input: DatabaseTuningAdvisorInput): RuleContext {
    if (!input.explainPlanText) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }

    const explainText = input.explainPlanText.trim();
    if (!explainText || (!isMysqlExplainJson(explainText) && !isMysqlExplainText(explainText))) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }

    try {
        const plan = parseMysqlExplainPlan(explainText);
        const nodes = flattenNodes(plan.root);
        const maxActualTimeMs = nodes.reduce((maxTime, node) => {
            if (node.actualTotalTimeMs === undefined) {
                return maxTime;
            }
            return Math.max(maxTime, node.actualTotalTimeMs);
        }, 0);

        return {
            sql: input.sql || '',
            nodes,
            rootCost: plan.root.costEnd,
            maxActualTimeMs: maxActualTimeMs > 0 ? maxActualTimeMs : undefined,
        };
    } catch {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }
}

export class MysqlTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addFullScanRecommendation(context, recommendations);
        this.addPotentialIndexRecommendation(context, recommendations);
        this.addFilesortRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);
        this.addSlowExecutionRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-001',
            title: 'Avoid SELECT * on repeatable MySQL workloads',
            summary: 'Selecting every column increases row width, buffer traffic, and can block covering-index plans.',
            severity: 'warning',
            confidence: clampConfidence(0.77),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run EXPLAIN FORMAT=JSON to confirm lower data-read and scan estimates.',
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
        const candidate = context.nodes.find((node) => isLargeFullScan(node));
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-002',
            title: 'Large full scan detected',
            summary: `${candidate.nodeType} on ${candidate.tableName ?? 'a relation'} estimates ${Math.round(getEstimatedRows(candidate)).toLocaleString()} rows.`,
            severity: getEstimatedRows(candidate) >= FULL_SCAN_ROW_THRESHOLD * 5 ? 'critical' : 'warning',
            confidence: clampConfidence(0.86),
            risk: 'high',
            actions: [
                'Review predicate selectivity and verify that the leading columns of your indexes match the WHERE or JOIN predicates.',
                'Run ANALYZE TABLE after significant data changes so the optimizer can reconsider access paths.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: getEstimatedRows(candidate),
                    details: candidate.filter,
                },
            ],
        });
    }

    private addPotentialIndexRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => hasPotentialIndexMiss(node));
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-003',
            title: 'Possible index opportunity or join access issue',
            summary:
                candidate.possibleKeys.length > 0
                    ? `${candidate.tableName ?? 'A table'} had possible keys (${candidate.possibleKeys.join(', ')}) but still used access type ${candidate.accessType ?? 'ALL'}.`
                    : `${candidate.tableName ?? 'A table'} used ${candidate.accessType ?? 'ALL'} access and join buffering, suggesting missing or misordered join keys.`,
            severity: 'warning',
            confidence: clampConfidence(0.79),
            risk: 'medium',
            actions: [
                'Check whether a composite index matching the filter and join prefix order would avoid the scan.',
                'If a suitable index already exists, compare predicate expressions and data types to ensure MySQL can use it.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.tableName ?? candidate.nodeType,
                    details: candidate.filter,
                },
            ],
        });
    }

    private addFilesortRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => usesFilesortOrTemporaryTable(node));
        if (!candidate) {
            return;
        }

        const summaryParts = [
            candidate.usingFilesort ? 'filesort' : undefined,
            candidate.usingTemporaryTable ? 'temporary table' : undefined,
        ].filter((value): value is string => Boolean(value));

        addRecommendation(output, {
            id: 'MYTA-004',
            title: 'Filesort or temporary table detected',
            summary:
                summaryParts.length > 0
                    ? `${candidate.nodeType} requires ${summaryParts.join(' and ')} work.`
                    : `${candidate.nodeType} shows sort or temporary-table overhead in EXPLAIN output.`,
            severity: 'warning',
            confidence: clampConfidence(0.84),
            risk: 'medium',
            actions: [
                'Review ORDER BY / GROUP BY columns and align indexes so MySQL can avoid external sort work.',
                'Reduce intermediate row counts before the sort or aggregation step when possible.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    details: candidate.detail ?? JSON.stringify(candidate.raw),
                },
            ],
        });
    }

    private addHighCostRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.rootCost < HIGH_COST_WARNING) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-005',
            title: 'Estimated MySQL plan cost is high',
            summary: `Root estimated cost is ${context.rootCost.toLocaleString()}.`,
            severity: context.rootCost >= HIGH_COST_CRITICAL ? 'critical' : 'warning',
            confidence: clampConfidence(0.8),
            risk: context.rootCost >= HIGH_COST_CRITICAL ? 'high' : 'medium',
            actions: [
                'Inspect the highest-cost scans and sort steps first.',
                'Reduce scanned rows, row width, and unneeded sort or temporary-table work before re-running EXPLAIN.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Root MySQL plan cost.',
                    value: context.rootCost,
                },
            ],
        });
    }

    private addRowEstimateRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => {
            if (node.actualRows === undefined) {
                return false;
            }

            const estimatedRows = getEstimatedRows(node);
            if (estimatedRows <= 0) {
                return false;
            }

            const larger = Math.max(node.actualRows, estimatedRows);
            const smaller = Math.max(1, Math.min(node.actualRows, estimatedRows));
            return larger / smaller >= ROW_MISESTIMATE_FACTOR;
        });

        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-006',
            title: 'Estimated rows differ sharply from actual rows',
            summary: `${candidate.nodeType} estimated ${Math.round(getEstimatedRows(candidate)).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.9),
            risk: 'medium',
            actions: [
                'Refresh optimizer statistics with ANALYZE TABLE on the involved tables.',
                'Check for skewed predicates or correlated conditions that may make cardinality estimates inaccurate.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.actualRows,
                },
            ],
        });
    }

    private addSlowExecutionRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.maxActualTimeMs === undefined || context.maxActualTimeMs < SLOW_NODE_WARNING_MS) {
            return;
        }

        const candidate = context.nodes.find(
            (node) => node.actualTotalTimeMs !== undefined && node.actualTotalTimeMs >= context.maxActualTimeMs!,
        );
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'MYTA-007',
            title: 'EXPLAIN ANALYZE shows a slow iterator',
            summary: `${candidate.nodeType} spent ${context.maxActualTimeMs.toFixed(1)} ms in the measured plan.`,
            severity: context.maxActualTimeMs >= SLOW_NODE_CRITICAL_MS ? 'warning' : 'info',
            confidence: clampConfidence(0.73),
            risk: context.maxActualTimeMs >= SLOW_NODE_CRITICAL_MS ? 'medium' : 'low',
            actions: [
                'Compare EXPLAIN ANALYZE timings before and after index or query-shape changes.',
                'If runtime remains high, inspect performance_schema statement and wait data for the same workload.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: context.maxActualTimeMs,
                    details:
                        candidate.actualRows !== undefined
                            ? `Observed rows: ${Math.round(candidate.actualRows).toLocaleString()}`
                            : undefined,
                },
            ],
        });
    }
}

export const mysqlTuningAdvisor: DatabaseTuningAdvisor = new MysqlTuningAdvisor();
