import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';
import {
    isPostgreSqlExplainJson,
    parsePostgreSqlExplainJson,
    type PostgreSqlExplainNode,
} from './postgresqlExplainParser';

interface RuleContext {
    sql: string;
    nodes: PostgreSqlExplainNode[];
    rootCost: number;
    planningTimeMs?: number;
    executionTimeMs?: number;
}

const FULL_SCAN_ROW_THRESHOLD = 50_000;
const NESTED_LOOP_WARNING_ROWS = 25_000;
const HIGH_COST_WARNING = 100_000;
const HIGH_COST_CRITICAL = 1_000_000;
const ROW_MISESTIMATE_FACTOR = 10;

function flattenNodes(root: PostgreSqlExplainNode): PostgreSqlExplainNode[] {
    const nodes: PostgreSqlExplainNode[] = [];
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

function isFullScan(node: PostgreSqlExplainNode): boolean {
    return /seq\s+scan|bitmap\s+heap\s+scan|cte\s+scan|subquery\s+scan/i.test(node.nodeType);
}

function isNestedLoop(node: PostgreSqlExplainNode): boolean {
    return /nested\s+loop/i.test(node.nodeType);
}

function hasDiskSpill(node: PostgreSqlExplainNode): boolean {
    const sortMethod = String(node.raw['Sort Method'] ?? '');
    const sortSpaceType = String(node.raw['Sort Space Type'] ?? '');
    const hashSpaceType = String(node.raw['Hash Space Type'] ?? '');
    const diskUsage = node.raw['Disk Usage'];

    if (/\bdisk\b/i.test(sortSpaceType) || /\bdisk\b/i.test(hashSpaceType)) {
        return true;
    }
    if (/external/i.test(sortMethod) || /\bdisk\b/i.test(sortMethod)) {
        return true;
    }
    if (typeof diskUsage === 'number') {
        return diskUsage > 0;
    }
    if (typeof diskUsage === 'string') {
        const parsed = Number(diskUsage);
        return Number.isFinite(parsed) ? parsed > 0 : /\bdisk\b/i.test(diskUsage);
    }

    return false;
}

function buildDiskSpillSummary(node: PostgreSqlExplainNode): string {
    const details = [
        typeof node.raw['Sort Method'] === 'string' ? `Sort Method: ${node.raw['Sort Method']}` : undefined,
        typeof node.raw['Sort Space Type'] === 'string' ? `Sort Space Type: ${node.raw['Sort Space Type']}` : undefined,
        typeof node.raw['Hash Space Type'] === 'string' ? `Hash Space Type: ${node.raw['Hash Space Type']}` : undefined,
        node.raw['Disk Usage'] !== undefined ? `Disk Usage: ${String(node.raw['Disk Usage'])}` : undefined,
    ].filter(Boolean);

    return details.length > 0 ? `${node.nodeType} spilled to disk (${details.join(', ')}).` : `${node.nodeType} spilled to disk.`;
}

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function extractContext(input: DatabaseTuningAdvisorInput): RuleContext {
    if (!input.explainPlanText || !isPostgreSqlExplainJson(input.explainPlanText)) {
        return {
            sql: input.sql || '',
            nodes: [],
            rootCost: 0,
        };
    }

    const plan = parsePostgreSqlExplainJson(input.explainPlanText);

    return {
        sql: input.sql || '',
        nodes: flattenNodes(plan.root),
        rootCost: plan.root.totalCost,
        planningTimeMs: plan.planningTimeMs,
        executionTimeMs: plan.executionTimeMs,
    };
}

export class PostgreSqlTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const context = extractContext(input);
        const recommendations: TuningRecommendation[] = [];

        this.addSelectStarRecommendation(context, recommendations);
        this.addFullScanRecommendation(context, recommendations);
        this.addNestedLoopRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addRowEstimateRecommendation(context, recommendations);
        this.addExecutionTimeRecommendation(context, recommendations);
        this.addDiskSpillRecommendation(context, recommendations);

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (!/\bSELECT\s+\*/i.test(context.sql)) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-001',
            title: 'Avoid SELECT * in production queries',
            summary: 'Selecting every column increases I/O and can block index-only access paths.',
            severity: 'warning',
            confidence: clampConfidence(0.76),
            risk: 'medium',
            actions: [
                'Project only the columns required by the consumer.',
                'Re-run EXPLAIN to confirm reduced row width and lower total cost.',
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
        const candidate = context.nodes.find((node) => isFullScan(node) && node.planRows >= FULL_SCAN_ROW_THRESHOLD);
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-002',
            title: 'Large full scan detected',
            summary: `${candidate.nodeType} estimates ${Math.round(candidate.planRows).toLocaleString()} rows.`,
            severity: 'warning',
            confidence: clampConfidence(0.83),
            risk: 'medium',
            actions: [
                'Review predicate selectivity and index coverage on the scanned relation.',
                'Trim projected columns so PostgreSQL can consider index-only paths where possible.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.planRows,
                    details: candidate.filter,
                },
            ],
        });
    }

    private addNestedLoopRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => isNestedLoop(node) && node.planRows >= NESTED_LOOP_WARNING_ROWS);
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-003',
            title: 'Nested loop join may be expensive at this row volume',
            summary: `Nested Loop estimates ${Math.round(candidate.planRows).toLocaleString()} rows.`,
            severity: candidate.planRows >= NESTED_LOOP_WARNING_ROWS * 4 ? 'critical' : 'warning',
            confidence: clampConfidence(0.87),
            risk: 'high',
            actions: [
                'Validate join predicates and available indexes on the inner side of the loop.',
                'Check whether a hash join or merge join rewrite would reduce repeated probes.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.planRows,
                },
            ],
        });
    }

    private addHighCostRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.rootCost < HIGH_COST_WARNING) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-004',
            title: 'Planner cost is high',
            summary: `Root plan cost is ${context.rootCost.toLocaleString()}.`,
            severity: context.rootCost >= HIGH_COST_CRITICAL ? 'critical' : 'warning',
            confidence: clampConfidence(0.81),
            risk: context.rootCost >= HIGH_COST_CRITICAL ? 'high' : 'medium',
            actions: [
                'Inspect the highest-cost operators first.',
                'Reduce scanned rows, unnecessary sorts, and repeated join probes.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Root PostgreSQL plan cost.',
                    value: context.rootCost,
                },
            ],
        });
    }

    private addRowEstimateRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => {
            if (node.actualRows === undefined || node.planRows <= 0) {
                return false;
            }

            const larger = Math.max(node.actualRows, node.planRows);
            const smaller = Math.max(1, Math.min(node.actualRows, node.planRows));
            return larger / smaller >= ROW_MISESTIMATE_FACTOR;
        });

        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-005',
            title: 'Planner row estimate differs sharply from actual rows',
            summary: `${candidate.nodeType} planned ${Math.round(candidate.planRows).toLocaleString()} rows but observed ${Math.round(candidate.actualRows ?? 0).toLocaleString()}.`,
            severity: 'warning',
            confidence: clampConfidence(0.9),
            risk: 'medium',
            actions: [
                'Refresh statistics with ANALYZE on the involved relation.',
                'Review predicates and data skew that may invalidate histogram estimates.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    value: candidate.actualRows ?? candidate.planRows,
                },
            ],
        });
    }

    private addExecutionTimeRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        if (context.executionTimeMs === undefined || context.executionTimeMs < 500) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-006',
            title: 'Execution time is materially higher than a quick interactive target',
            summary: `EXPLAIN ANALYZE reported ${context.executionTimeMs.toFixed(1)} ms execution time.`,
            severity: context.executionTimeMs >= 2_000 ? 'warning' : 'info',
            confidence: clampConfidence(0.71),
            risk: context.executionTimeMs >= 2_000 ? 'medium' : 'low',
            actions: [
                'Compare execution time before and after applying index/query-shape changes.',
                'If this runs frequently, baseline the statement with pg_stat_statements or query history.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: 'Execution time reported by PostgreSQL.',
                    value: context.executionTimeMs,
                    details:
                        context.planningTimeMs !== undefined
                            ? `Planning time: ${context.planningTimeMs.toFixed(1)} ms`
                            : undefined,
                },
            ],
        });
    }

    private addDiskSpillRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const candidate = context.nodes.find((node) => hasDiskSpill(node));
        if (!candidate) {
            return;
        }

        addRecommendation(output, {
            id: 'PGTA-007',
            title: 'Plan spilled work to disk',
            summary: buildDiskSpillSummary(candidate),
            severity: 'warning',
            confidence: clampConfidence(0.86),
            risk: 'medium',
            actions: [
                'Review whether the session or workload work_mem setting is large enough for this sort/hash workload.',
                'Re-run EXPLAIN ANALYZE after query or memory-setting changes to confirm the spill disappears.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: candidate.nodeType,
                    details: JSON.stringify(candidate.raw),
                },
            ],
        });
    }
}

export const postgresqlTuningAdvisor: DatabaseTuningAdvisor = new PostgreSqlTuningAdvisor();
