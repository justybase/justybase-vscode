import {
    clampConfidence,
    createTuningReport,
    TuningRecommendation,
    TuningReport
} from '../../../services/tuning/types';

export interface NetezzaTuningAdvisorInput {
    sql: string;
    explainPlanText?: string;
    tableStatsText?: string | string[];
}

export interface NetezzaTuningAdvisorOptions {
    skewWarningThreshold?: number;
    nestedLoopRowThreshold?: number;
    highCostWarningThreshold?: number;
    highCostCriticalThreshold?: number;
}

interface ParsedExplainNode {
    type: string;
    costEnd: number;
    rows: number;
    confidence: number;
    raw: string;
}

interface ParsedTableStats {
    tableTarget?: string;
    skewRatio?: number;
    distributionKey?: string;
    rowCount?: number;
    hasDistributionDataIssue: boolean;
}

interface RuleContext {
    sql: string;
    explainNodes: ParsedExplainNode[];
    tableStats: ParsedTableStats[];
}

const DEFAULT_OPTIONS: Required<NetezzaTuningAdvisorOptions> = {
    skewWarningThreshold: 20,
    nestedLoopRowThreshold: 100_000,
    highCostWarningThreshold: 10_000_000,
    highCostCriticalThreshold: 10_000_000_000
};

export class NetezzaTuningAdvisor {
    private options: Required<NetezzaTuningAdvisorOptions>;

    constructor(options: NetezzaTuningAdvisorOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    public analyze(input: NetezzaTuningAdvisorInput): TuningReport {
        const sql = input.sql || '';
        const explainNodes = parseExplainNodes(input.explainPlanText || '');
        const tableStats = parseTableStats(input.tableStatsText);
        const context: RuleContext = {
            sql,
            explainNodes,
            tableStats
        };

        const recommendations = this.evaluateRules(context);
        return createTuningReport(recommendations, sql.length);
    }

    private evaluateRules(context: RuleContext): TuningRecommendation[] {
        const recommendations: TuningRecommendation[] = [];
        this.addSelectStarRecommendation(context, recommendations);
        this.addNestedLoopRecommendation(context, recommendations);
        this.addHighCostRecommendation(context, recommendations);
        this.addLowConfidenceRecommendation(context, recommendations);
        this.addSkewRecommendation(context, recommendations);
        this.addDistributionKeyRecommendation(context, recommendations);
        this.addDistributionDataIssueRecommendation(context, recommendations);
        return recommendations;
    }

    private addSelectStarRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const sqlWithoutComments = stripSqlComments(context.sql);
        if (!/\bSELECT\s+\*/i.test(sqlWithoutComments)) {
            return;
        }

        output.push({
            id: 'NZTA-001',
            title: 'Avoid SELECT * in production queries',
            summary: 'SELECT * increases I/O and may fetch unnecessary columns.',
            severity: 'warning',
            confidence: clampConfidence(0.76),
            risk: 'medium',
            actions: [
                'Replace SELECT * with explicit column list.',
                'Keep only columns required by downstream logic.'
            ],
            evidence: [
                {
                    source: 'sql_analysis',
                    summary: 'Query contains SELECT * pattern.'
                }
            ]
        });
    }

    private addNestedLoopRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const nestedLoopNode = context.explainNodes.find(
            node => node.type.includes('Nested Loop') && node.rows >= this.options.nestedLoopRowThreshold
        );
        if (!nestedLoopNode) {
            return;
        }

        output.push({
            id: 'NZTA-002',
            title: 'Nested Loop with high row count detected',
            summary: `Nested Loop estimates ${nestedLoopNode.rows.toLocaleString()} rows and may be expensive.`,
            severity: 'critical',
            confidence: clampConfidence(0.9),
            risk: 'high',
            actions: [
                'Review join predicates and data distribution keys.',
                'Consider rewriting join strategy to reduce nested-loop amplification.'
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: nestedLoopNode.raw,
                    value: nestedLoopNode.rows
                }
            ]
        });
    }

    private addHighCostRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const highestCostNode = context.explainNodes.reduce<ParsedExplainNode | undefined>((max, node) => {
            if (!max || node.costEnd > max.costEnd) {
                return node;
            }
            return max;
        }, undefined);

        if (!highestCostNode || highestCostNode.costEnd < this.options.highCostWarningThreshold) {
            return;
        }

        const isCritical = highestCostNode.costEnd >= this.options.highCostCriticalThreshold;
        output.push({
            id: 'NZTA-003',
            title: 'High estimated execution cost',
            summary: `Plan cost is ${highestCostNode.costEnd.toLocaleString()}, suggesting expensive execution.`,
            severity: isCritical ? 'critical' : 'warning',
            confidence: clampConfidence(0.82),
            risk: isCritical ? 'high' : 'medium',
            actions: [
                'Run EXPLAIN VERBOSE and inspect most expensive operators.',
                'Reduce scanned rows by pushing predicates and pruning columns.'
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: highestCostNode.raw,
                    value: highestCostNode.costEnd
                }
            ]
        });
    }

    private addLowConfidenceRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const lowConfidenceNode = context.explainNodes.find(node => node.confidence === 0);
        if (!lowConfidenceNode) {
            return;
        }

        output.push({
            id: 'NZTA-004',
            title: 'Plan confidence is low (statistics may be stale)',
            summary: 'EXPLAIN reported confidence 0, which often indicates outdated statistics.',
            severity: 'warning',
            confidence: clampConfidence(0.78),
            risk: 'medium',
            actions: [
                'Run GENERATE STATISTICS on involved tables.',
                'Re-run EXPLAIN and compare confidence/cost deltas.'
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: lowConfidenceNode.raw,
                    value: lowConfidenceNode.confidence
                }
            ]
        });
    }

    private addSkewRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const skewStats = context.tableStats
            .filter(stats => stats.skewRatio !== undefined)
            .sort((a, b) => (b.skewRatio || 0) - (a.skewRatio || 0))[0];
        const skewRatio = skewStats?.skewRatio;
        if (skewRatio === undefined || skewRatio <= this.options.skewWarningThreshold) {
            return;
        }
        const targetSuffix = skewStats?.tableTarget ? ` for ${skewStats.tableTarget}` : '';

        output.push({
            id: 'NZTA-005',
            title: 'High data skew detected',
            summary: `Skew ratio${targetSuffix} is ${skewRatio.toFixed(1)}%, above threshold ${this.options.skewWarningThreshold}%.`,
            severity: 'critical',
            confidence: clampConfidence(0.88),
            risk: 'high',
            actions: [
                'Review and adjust DISTRIBUTE ON key for this table.',
                'Validate data distribution after remediation.'
            ],
            evidence: [
                {
                    source: 'skew_check',
                    summary: skewStats?.tableTarget
                        ? `Skew ratio from table statistics (${skewStats.tableTarget}).`
                        : 'Skew ratio from table statistics.',
                    value: skewRatio
                }
            ]
        });
    }

    private addDistributionKeyRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const randomDistributionStats = context.tableStats
            .filter(stats => stats.distributionKey?.trim().toUpperCase() === 'RANDOM');
        if (randomDistributionStats.length === 0) {
            return;
        }

        const randomDistributionTables = randomDistributionStats.map(stats => stats.tableTarget || 'unknown table');
        const preview = randomDistributionTables.slice(0, 3).join(', ');
        const additionalCount = randomDistributionTables.length - Math.min(3, randomDistributionTables.length);

        output.push({
            id: 'NZTA-006',
            title: 'Table uses RANDOM distribution key',
            summary: `RANDOM distribution can increase data movement for joins in Netezza workloads (${preview}${additionalCount > 0 ? `, +${additionalCount} more` : ''}).`,
            severity: 'warning',
            confidence: clampConfidence(0.72),
            risk: 'medium',
            actions: [
                'Evaluate join/filter columns and consider explicit DISTRIBUTE ON.',
                'Benchmark before/after plan cost and skew.'
            ],
            evidence: [
                {
                    source: 'table_stats',
                    summary: 'Distribution key parsed from table statistics.',
                    value: 'RANDOM'
                }
            ]
        });
    }

    private addDistributionDataIssueRecommendation(context: RuleContext, output: TuningRecommendation[]): void {
        const affectedStats = context.tableStats.filter(stats => stats.hasDistributionDataIssue);
        if (affectedStats.length === 0) {
            return;
        }

        const affectedTables = affectedStats.map(stats => stats.tableTarget || 'unknown table');
        const preview = affectedTables.slice(0, 3).join(', ');
        const additionalCount = affectedTables.length - Math.min(3, affectedTables.length);

        output.push({
            id: 'NZTA-007',
            title: 'Distribution/skew details unavailable',
            summary: `Unable to retrieve full distribution data; tuning confidence is reduced (${preview}${additionalCount > 0 ? `, +${additionalCount} more` : ''}).`,
            severity: 'info',
            confidence: clampConfidence(0.6),
            risk: 'low',
            actions: [
                'Run table skew check manually and verify DATASLICEID distribution.',
                'Ensure table statistics and permissions allow skew diagnostics.'
            ],
            evidence: [
                {
                    source: 'table_stats',
                    summary: 'Table stats report indicates missing distribution data.'
                }
            ]
        });
    }
}

function parseExplainNodes(explainPlanText: string): ParsedExplainNode[] {
    if (!explainPlanText.trim()) {
        return [];
    }

    const lines = explainPlanText
        .split('\n')
        .map(line => line.replace(/^NOTICE:\s*/i, '').trim())
        .filter(line => line.length > 0);

    const regex =
        /^[\s]*(?:[lr]:\s*)?([\w\s-]+?)(?:\s+table\s+"(\w+)")?(?:\s+{[^}]*})?\s*\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+width=(\d+)\s+conf=([\d.]+)\)/i;

    const nodes: ParsedExplainNode[] = [];
    for (const line of lines) {
        const match = line.match(regex);
        if (!match) {
            continue;
        }
        const [, type, , , costEnd, rows, , confidence] = match;
        nodes.push({
            type: type.trim(),
            costEnd: Number(costEnd),
            rows: Number(rows),
            confidence: Number(confidence),
            raw: line
        });
    }
    return nodes;
}

function parseTableStats(tableStatsText?: string | string[]): ParsedTableStats[] {
    if (!tableStatsText) {
        return [];
    }

    const chunks = (Array.isArray(tableStatsText) ? tableStatsText : [tableStatsText])
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length > 0);

    return chunks.map(parseSingleTableStats);
}

function parseSingleTableStats(tableStatsText: string): ParsedTableStats {
    const tableTargetMatch = tableStatsText.match(/##\s*Table Statistics:\s*([^\n\r]+)/i);
    const skewRatio = extractFirstNumber(tableStatsText, /\*?\*?\s*Skew Ratio:\*?\*?\s*([0-9]+(?:[.,][0-9]+)?)%/i);
    const distributionKeyMatch = tableStatsText.match(/\*?\*?\s*Distribution Key:\*?\*?\s*([^\n\r]+)/i);
    const rowCount = extractFirstNumber(tableStatsText, /\*?\*?\s*(?:Row Count|Estimated Row Count):\*?\*?\s*([\d,]+)/i);
    const distributionDataIssuePatterns = [
        /No distribution data available/i,
        /Could not retrieve distribution data/i,
        /Unable to retrieve/i
    ];

    return {
        tableTarget: tableTargetMatch ? tableTargetMatch[1].trim() : undefined,
        skewRatio,
        distributionKey: distributionKeyMatch ? distributionKeyMatch[1].trim() : undefined,
        rowCount,
        hasDistributionDataIssue: distributionDataIssuePatterns.some(pattern => pattern.test(tableStatsText))
    };
}

function extractFirstNumber(text: string, regex: RegExp): number | undefined {
    const match = text.match(regex);
    if (!match) {
        return undefined;
    }

    const normalized = match[1].replace(',', '.').replace(/[^\d.]/g, '');
    if (!normalized) {
        return undefined;
    }
    const value = Number(normalized);
    return Number.isNaN(value) ? undefined : value;
}

function stripSqlComments(sql: string): string {
    return sql
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}
