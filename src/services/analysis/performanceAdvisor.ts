import { analyzeExplainPlanSemantic, type ExplainPlanSemanticAnalysis } from '../tuning/explainPlanSemanticAnalyzer';
import { createTuningReport, type TuningEvidence, type TuningRecommendation, type TuningReport } from '../tuning/types';
import { analyzeSql, objectId, objectLabel, type ObjectReference, type SqlAnalysis, type SqlLocation } from './sqlAnalysis';

/** HASH means co-located on keys; RANDOM means no co-location; UNKNOWN means the catalog did not say. */
export type TableDistribution = { kind: 'hash'; keys: string[] } | { kind: 'random' } | { kind: 'unknown' };
export interface PerformanceTable {
    object: ObjectReference;
    distribution?: TableDistribution;
    columns?: { name: string; type?: string }[];
    rows?: number;
    skewRatio?: number;
    skewCoverage?: 'populated-slices';
    averageRowsPerSlice?: number;
    maximumRowsPerSlice?: number;
    /** Catalog-level optimizer statistics state; NZPERF003A only fires when proven missing. */
    statisticsState?: 'missing' | 'available' | 'unknown';
}
export interface PerformanceFinding extends TuningRecommendation {
    category: 'distribution' | 'skew' | 'statistics' | 'scan' | 'join' | 'filter' | 'sort' | 'aggregation' | 'cardinality' | 'result-size';
    object?: ObjectReference;
    sqlRange?: SqlLocation;
    planNodeIds?: number[];
}
export interface PerformanceReport extends TuningReport {
    recommendations: PerformanceFinding[];
    issues: string[];
    plan?: ExplainPlanSemanticAnalysis;
    sql: string;
}
export interface PerformanceInput {
    sql: string;
    context: ObjectReference;
    tables?: PerformanceTable[];
    explainPlanText?: string;
    issues?: string[];
    analysis?: SqlAnalysis;
    plan?: ExplainPlanSemanticAnalysis;
}
const LARGE_ROWS = 1_000_000;
const describeDistribution = (distribution: TableDistribution): string =>
    distribution.kind === 'hash' ? `HASH (${distribution.keys.join(', ')})` : distribution.kind.toUpperCase();
/** The advisor only tracks relations; parser references are UNKNOWN, so normalize relation identity. */
const relationId = (object: ObjectReference): string => objectId({ ...object, type: 'UNKNOWN' });
/** Evidence-driven Netezza rules, using the existing tuning evidence and plan model. */
export function analyzeNetezzaPerformance(input: PerformanceInput): PerformanceReport {
    const analysis = input.analysis ?? analyzeSql(input.sql, input.context);
    const tables = new Map((input.tables ?? []).map(t => [relationId(t.object), t]));
    const plan = input.plan ?? (input.explainPlanText ? analyzeExplainPlanSemantic(input.explainPlanText) : undefined);
    const findings: PerformanceFinding[] = [];
    const advisorIssues: string[] = [];
    const add = (finding: PerformanceFinding) => findings.push(finding);
    const base = (id: string, category: PerformanceFinding['category'], title: string, summary: string, evidence: TuningEvidence[], confidence = 0.8): PerformanceFinding => ({
        id, category, title, summary, severity: 'warning', confidence, risk: 'medium', actions: [], evidence
    });
    const groups = new Map<string, typeof analysis.joins>();
    for (const join of analysis.joins) {
        const key = [relationId(join.left.target), relationId(join.right.target)].sort().join('|');
        const group = groups.get(key) ?? [];
        group.push(join); groups.set(key, group);
        const left = tables.get(relationId(join.left.target))?.columns?.find(c => c.name === join.left.column);
        const right = tables.get(relationId(join.right.target))?.columns?.find(c => c.name === join.right.column);
        if (left?.type && right?.type && left.type.toUpperCase() !== right.type.toUpperCase()) {
            add({ ...base('NZPERF006', 'join', 'Join column types differ', `${left.type} and ${right.type} may require conversion; verify compatible types.`, [
                { source: 'sql_analysis', summary: `${join.left.column} = ${join.right.column}` }, { source: 'table_stats', summary: 'Cached column types', details: `${left.type} / ${right.type}` }
            ]), sqlRange: join.left.location });
        }
    }
    for (const group of groups.values()) {
        const first = group[0];
        const left = tables.get(relationId(first.left.target));
        const right = tables.get(relationId(first.right.target));
        if (!left || !right) { continue; }
        const leftDistribution = left.distribution;
        const rightDistribution = right.distribution;
        const mappings = group.map(j => relationId(j.left.target) === relationId(left.object) ? [j.left.column, j.right.column] : [j.right.column, j.left.column]);
        if (leftDistribution?.kind === 'hash' && rightDistribution?.kind === 'hash') {
            const aligned = leftDistribution.keys.length === rightDistribution.keys.length && leftDistribution.keys.every((key, i) => mappings.some(([l,r]) => l === key && r === rightDistribution.keys[i]));
            if (!aligned) {
                const finding = base('NZPERF001', 'distribution', 'Join may require redistribution', 'Distribution keys do not align fully with the equality join. Review distribution against the wider workload before making changes.', [
                    { source: 'sql_analysis', summary: 'Equality join columns', details: mappings.map(m => m.join(' = ')).join(', ') },
                    { source: 'table_stats', summary: `${objectLabel(left.object)} DISTRIBUTE ON (${leftDistribution.keys.join(', ')})` },
                    { source: 'table_stats', summary: `${objectLabel(right.object)} DISTRIBUTE ON (${rightDistribution.keys.join(', ')})` }
                ], 0.7);
                finding.object = right.object; finding.sqlRange = first.right.location; add(finding);
            }
        } else if (leftDistribution && rightDistribution && leftDistribution.kind !== 'unknown' && rightDistribution.kind !== 'unknown') {
            // At least one RANDOM side cannot be co-located on a hash key.
            const randomSide = leftDistribution.kind === 'random' ? left : right;
            const finding = base('NZPERF001', 'distribution', 'Join may require data movement',
                'At least one side of this join is DISTRIBUTE ON RANDOM, so the join cannot be co-located on a hash key and may move rows. Review distribution against the wider workload before making changes.', [
                { source: 'sql_analysis', summary: 'Equality join columns', details: mappings.map(m => m.join(' = ')).join(', ') },
                { source: 'table_stats', summary: `${objectLabel(left.object)} distribution is ${describeDistribution(leftDistribution)}` },
                { source: 'table_stats', summary: `${objectLabel(right.object)} distribution is ${describeDistribution(rightDistribution)}` }
            ], leftDistribution.kind === 'random' && rightDistribution.kind === 'random' ? 0.65 : 0.7);
            finding.object = randomSide.object; finding.sqlRange = first.right.location; add(finding);
        } else {
            advisorIssues.push(`${objectLabel(left.object)} / ${objectLabel(right.object)}: distribution is unknown; the alignment check was skipped.`);
        }
    }
    const referenced = new Set(analysis.references.map(ref => relationId(ref.target)));
    const wildcardTargets = new Set(analysis.references.filter(ref => ref.kind === 'wildcard').map(ref => relationId(ref.target)));
    for (const table of tables.values()) {
        if (!referenced.has(relationId(table.object))) { continue; }
        if (table.skewRatio !== undefined && table.skewRatio >= 2) {
            const finding = base('NZPERF002', 'skew', 'Significant distribution skew', `${objectLabel(table.object)} has uneven rows per slice; skew can limit parallelism in this query.`, [
                { source: 'skew_check', summary: table.skewCoverage === 'populated-slices' ? 'Maximum / average rows per populated slice (lower bound)' : 'Maximum / average rows per slice', value: table.skewRatio, details: `Average: ${table.averageRowsPerSlice ?? 'unknown'}; maximum: ${table.maximumRowsPerSlice ?? 'unknown'}` }
            ], 0.95);
            finding.object = table.object;
            if (table.rows !== undefined && table.rows >= LARGE_ROWS) { finding.severity = 'critical'; }
            add(finding);
        }
        if (table.statisticsState === 'missing' && (table.rows ?? 0) >= LARGE_ROWS) {
            add({ ...base('NZPERF003A', 'statistics', 'Missing optimizer statistics (catalog)', `The catalog reports missing statistics for ${objectLabel(table.object)}. Consider GENERATE STATISTICS after reviewing the maintenance workload.`, [{ source: 'table_stats', summary: 'Catalog reports missing statistics', value: table.rows }], 0.9), object: table.object });
        }
        if (wildcardTargets.has(relationId(table.object)) && (table.columns?.length ?? 0) >= 40 && (table.rows ?? 0) >= LARGE_ROWS) {
            add({ ...base('NZPERF008', 'result-size', 'Wide SELECT * on a large relation', `${objectLabel(table.object)} has ${table.columns!.length} columns. Select required columns to reduce processing and result transfer when semantics allow.`, [
                { source: 'sql_analysis', summary: 'SELECT * detected' }, { source: 'table_stats', summary: 'Column count and row estimate', details: `${table.columns!.length} columns; ${table.rows} rows` }
            ], 0.7), severity: 'info', object: table.object });
        }
    }
    for (const pattern of analysis.patterns) {
        if (pattern.kind === 'conversion') {
            add({ ...base('NZPERF005', 'filter', 'Conversion in a join or filter', 'A function or cast is evaluated in a predicate. Review type compatibility and whether a comparison using the column’s native type preserves semantics.', [{ source: 'sql_analysis', summary: 'CST function/cast inside join/filter' }], 0.6), sqlRange: pattern.location });
        }
        if (pattern.kind === 'cartesian') {
            add({ ...base('NZPERF007', 'join', 'Join has no condition', 'This join can multiply input rows. Verify that a Cartesian result is intentional.', [{ source: 'sql_analysis', summary: 'JOIN without ON/USING/NATURAL' }], 0.9), sqlRange: pattern.location });
        }
        if (pattern.kind === 'union') {
            add({ ...base('NZPERF010', 'aggregation', 'UNION performs duplicate elimination', 'If duplicate elimination is not required, UNION ALL can avoid that work. Preserve result semantics.', [{ source: 'sql_analysis', summary: 'UNION without ALL' }], 0.9), severity: 'info', sqlRange: pattern.location });
        }
    }
    for (const node of plan?.nodes ?? []) {
        const evidence: TuningEvidence[] = [{ source: 'explain_plan', summary: `Step ${node.id}: ${node.operator}`, value: node.rows, details: node.raw }];
        if (/redistribute|broadcast|fabric|motion|repartition/i.test(node.operator) && node.rows >= LARGE_ROWS) {
            add({ ...base('NZPERF011', 'distribution', 'Large data movement in EXPLAIN', 'The optimizer estimates a large movement of rows between slices. Review upstream filters and workload distribution alignment.', evidence, 0.95), severity: 'critical', planNodeIds: [node.id] });
        }
        if (/scan/i.test(node.operator) && node.rows >= LARGE_ROWS) {
            add({ ...base('NZPERF004', 'scan', 'Large estimated scan', 'This scan processes a large estimated row set. Review selective predicates and zone-map-friendly filters; a scan can still be appropriate.', evidence, 0.85), planNodeIds: [node.id] });
        }
        if (node.confidence === 0 && node.rows >= LARGE_ROWS && /scan/i.test(node.operator)) {
            add({ ...base('NZPERF003B', 'statistics', 'Low-confidence large scan estimate', 'EXPLAIN confidence is zero. Statistics may be missing or insufficient; verify before generating statistics. No last-updated date is inferred.', evidence, 0.65), planNodeIds: [node.id] });
        }
        if (/sort|aggregate|group|unique|distinct/i.test(node.operator) && node.rows >= LARGE_ROWS) {
            add({ ...base('NZPERF009', /sort/i.test(node.operator) ? 'sort' : 'aggregation', 'Large sort or aggregation', 'EXPLAIN estimates substantial sort/aggregation work. Review whether filtering or reducing columns earlier preserves semantics.', evidence, 0.9), planNodeIds: [node.id] });
        }
        const children = plan!.edges.filter(e => e.from === node.id).map(e => plan!.nodes.find(n => n.id === e.to)).filter(n => n !== undefined);
        const inputRows = children.reduce((sum, child) => sum + child.rows, 0);
        if (/join/i.test(node.operator) && inputRows > 0 && node.rows >= LARGE_ROWS && node.rows >= inputRows * 10) {
            add({ ...base('NZPERF012', 'cardinality', 'Estimated intermediate row explosion', `Estimated join output ${node.rows} rows exceeds its inputs (${inputRows}) by at least 10×. Investigate duplicate matches and join cardinality.`, [...evidence, { source: 'explain_plan', summary: 'Combined child row estimates', value: inputRows }], 0.9), severity: 'critical', planNodeIds: [node.id, ...children.map(n => n.id)] });
        }
    }
    const issues = [...analysis.issues, ...(input.issues ?? []), ...advisorIssues];
    if (!plan) { issues.push('EXPLAIN unavailable: only static and available metadata evidence is shown.'); }
    else if (!plan.nodes.length) { issues.push('EXPLAIN format could not be structured; raw plan remains available.'); }
    if (!input.tables?.length) { issues.push('Table metadata unavailable; distribution, skew and statistics conclusions are limited.'); }
    return { ...createTuningReport(findings, input.sql.length), recommendations: findings, issues: [...new Set(issues)], plan, sql: input.sql };
}
