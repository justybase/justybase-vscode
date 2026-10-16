// Turns a flag's evidence into labelled rows. Pure: the same rows feed the 'Why?' disclosure and the
// CSV export, so the two can never disagree about what a flag measured.

import { DETECTION_MODE_LABEL } from './anomalyRules.js';
import { formatStatNumber } from './elements.js';
import type { AnomalyFlag, FlagEvidence } from './types.js';

export interface EvidenceRow {
    label: string;
    value: string;
}

function formatValue(value: number | string | null): string {
    if (value === null) return '—';
    if (typeof value === 'number') return formatStatNumber(value);
    return value;
}

export function evidenceRows(flag: AnomalyFlag): EvidenceRow[] {
    const evidence: FlagEvidence = flag.evidence;
    const threshold = evidence.threshold === null
        ? evidence.thresholdLabel
        : `${evidence.thresholdLabel} (${formatStatNumber(evidence.threshold)})`;
    const effect = evidence.effect === null
        ? '—'
        : `${formatStatNumber(evidence.effect)} ${evidence.effectUnit}`;
    const sample = evidence.baselineSize === undefined
        ? `${evidence.sampleSize} rows`
        : `${evidence.sampleSize} rows vs ${evidence.baselineSize} in baseline`;
    return [
        { label: 'Method', value: evidence.method },
        { label: 'Baseline', value: DETECTION_MODE_LABEL[evidence.baseline] },
        { label: 'Observed', value: `${evidence.observedLabel}: ${formatValue(evidence.observed)}` },
        { label: 'Expected', value: `${evidence.expectedLabel}: ${formatValue(evidence.expected)}` },
        { label: 'Threshold', value: threshold },
        { label: 'Effect', value: effect },
        { label: 'Sample', value: sample },
        { label: 'Notes', value: evidence.notes?.join('; ') ?? '—' },
    ];
}
