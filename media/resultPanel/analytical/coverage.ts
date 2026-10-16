// Human-readable notices for the reduced coverage an engine reports in AnalyticalDataset.coverage.
// When a rule could not run for a column (bounded work or approximate counts), the view says so
// instead of silently showing "no anomalies". Pure module: no DOM, no host calls.

import type { AnalyticalDataset, SkippedEvaluationReason } from './types.js';

const REASON_LABEL: Record<SkippedEvaluationReason, string> = {
    'too-many-distinct': 'too many distinct values',
    'too-many-groups': 'too many groups',
    'not-numeric': 'values are stored as text',
    'approximate': 'counts are approximate in memory',
};

/** Short rule titles, matching the catalogue; unknown ids fall back to the raw id. */
const RULE_LABEL: Record<string, string> = {
    TOP_VALUE_DOMINANCE: 'Dominant value',
    MIX_SHIFT: 'Category mix shift',
    MEAN_SHIFT: 'Mean shift',
    RANGE_OUTLIER: 'Range outlier',
    HIGH_VARIABILITY: 'High variability',
    RARE_VALUE: 'Rare value',
};

const MAX_COLUMNS_PER_NOTICE = 4;

/**
 * One sentence per reason a rule was skipped, aggregating the affected rules and columns. The caller
 * resolves a column index to its name; an empty list means full coverage.
 */
export function describeCoverageSkips(
    dataset: AnalyticalDataset,
    nameOf: (columnIndex: number) => string,
): string[] {
    const skipped = dataset.coverage?.skipped;
    if (!skipped || skipped.length === 0) {
        return [];
    }
    const byReason = new Map<SkippedEvaluationReason, { rules: Set<string>; columns: Set<string> }>();
    for (const entry of skipped) {
        const bucket = byReason.get(entry.reason) ?? { rules: new Set<string>(), columns: new Set<string>() };
        for (const rule of entry.rules) {
            bucket.rules.add(RULE_LABEL[rule] ?? rule);
        }
        bucket.columns.add(nameOf(entry.columnIndex));
        byReason.set(entry.reason, bucket);
    }
    const notices: string[] = [];
    for (const [reason, bucket] of byReason) {
        const rules = [...bucket.rules].sort().join(', ');
        const columns = [...bucket.columns].sort();
        const shown = columns.slice(0, MAX_COLUMNS_PER_NOTICE).join(', ');
        const more = columns.length > MAX_COLUMNS_PER_NOTICE ? ` and ${columns.length - MAX_COLUMNS_PER_NOTICE} more` : '';
        notices.push(`Not evaluated for ${shown}${more} (${REASON_LABEL[reason]}): ${rules}.`);
    }
    return notices;
}
