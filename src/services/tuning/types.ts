export type TuningSeverity = 'info' | 'warning' | 'critical';

export type TuningRisk = 'low' | 'medium' | 'high';

export type TuningEvidenceSource = 'explain_plan' | 'table_stats' | 'skew_check' | 'sql_analysis';

export interface TuningEvidence {
    source: TuningEvidenceSource;
    summary: string;
    value?: string | number | boolean | null;
    details?: string;
}

export interface TuningRecommendation {
    id: string;
    title: string;
    summary: string;
    severity: TuningSeverity;
    confidence: number;
    risk: TuningRisk;
    actions: string[];
    evidence: TuningEvidence[];
}

export interface TuningReportMetadata {
    queryLength: number;
    recommendationCount: number;
    analyzedAt: string;
}

export interface TuningReport {
    summary: string;
    recommendations: TuningRecommendation[];
    metadata: TuningReportMetadata;
}

export function clampConfidence(value: number): number {
    if (Number.isNaN(value)) {
        return 0;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return Math.round(value * 100) / 100;
}

export function buildTuningSummary(recommendations: TuningRecommendation[]): string {
    const critical = recommendations.filter(r => r.severity === 'critical').length;
    const warning = recommendations.filter(r => r.severity === 'warning').length;
    const info = recommendations.filter(r => r.severity === 'info').length;
    return `Detected ${recommendations.length} recommendation(s): ${critical} critical, ${warning} warning, ${info} info.`;
}

export function createTuningReport(
    recommendations: TuningRecommendation[],
    queryLength: number,
    analyzedAt: string = new Date().toISOString()
): TuningReport {
    return {
        summary: buildTuningSummary(recommendations),
        recommendations,
        metadata: {
            queryLength,
            recommendationCount: recommendations.length,
            analyzedAt
        }
    };
}
