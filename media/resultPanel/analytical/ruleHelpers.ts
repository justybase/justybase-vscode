// Shared helpers for every detection mode: severity, flag construction and number formatting.
// Pure module: no DOM or host dependencies. Rule modules import from here so the evidence and
// severity rules are defined once.

import type { AnalyticalColumnStats, AnomalyFlag, AnomalyRuleId, AnomalySeverity, DetectionMode, FlagEvidence } from './types.js';

export const DETECTION_MODE_LABEL: Record<DetectionMode, string> = {
    whole: 'whole result',
    rest: 'rest of result',
    robust: 'whole result, median and IQR',
    peer: 'peer groups',
    reference: 'reference group',
};


export function severityForStrength(strength: number): AnomalySeverity {
    if (strength >= 0.7) return 'high';
    if (strength >= 0.35) return 'warn';
    return 'info';
}

export function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

export function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

export interface RuleContext {
    k: number;
    mode: DetectionMode;
}

export type EvidenceDraft = Omit<FlagEvidence, 'baseline'>;

export function flag(
    rule: AnomalyRuleId,
    strength: number,
    message: string,
    evidence: EvidenceDraft,
    ctx: RuleContext,
    columnIndex?: number,
): AnomalyFlag {
    const clamped = clamp01(strength);
    return {
        rule,
        severity: severityForStrength(clamped),
        columnIndex,
        strength: clamped,
        message,
        evidence: { ...evidence, baseline: ctx.mode },
    };
}


export function nonNull(stats: AnalyticalColumnStats): number {
    return stats.rowCount - stats.nullCount;
}


export function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e6 || abs < 0.01)) return value.toExponential(2);
    return Number(value.toFixed(2)).toLocaleString('en-US');
}
