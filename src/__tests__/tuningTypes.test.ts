import {
    buildTuningSummary,
    clampConfidence,
    createTuningReport,
    TuningRecommendation
} from '../services/tuning/types';

describe('services/tuning/types', () => {
    describe('clampConfidence', () => {
        it('clamps to [0,1] and rounds to 2 decimals', () => {
            expect(clampConfidence(-1)).toBe(0);
            expect(clampConfidence(2)).toBe(1);
            expect(clampConfidence(Number.NaN)).toBe(0);
            expect(clampConfidence(0.1234)).toBe(0.12);
            expect(clampConfidence(0.1299)).toBe(0.13);
        });
    });

    describe('buildTuningSummary', () => {
        it('returns grouped severity summary', () => {
            const recommendations: TuningRecommendation[] = [
                {
                    id: 'R1',
                    title: 'Skew',
                    summary: 'High skew detected',
                    severity: 'critical',
                    confidence: 0.9,
                    risk: 'high',
                    actions: ['Review distribution key'],
                    evidence: [{ source: 'skew_check', summary: 'Skew ratio > 20%' }]
                },
                {
                    id: 'R2',
                    title: 'Stats',
                    summary: 'Statistics may be stale',
                    severity: 'warning',
                    confidence: 0.7,
                    risk: 'medium',
                    actions: ['Run GENERATE STATISTICS'],
                    evidence: [{ source: 'table_stats', summary: 'Confidence low in explain' }]
                }
            ];

            expect(buildTuningSummary(recommendations)).toBe(
                'Detected 2 recommendation(s): 1 critical, 1 warning, 0 info.'
            );
        });
    });

    describe('createTuningReport', () => {
        it('builds report with summary and metadata', () => {
            const recommendations: TuningRecommendation[] = [];
            const report = createTuningReport(recommendations, 512, '2026-02-24T17:20:00.000Z');

            expect(report.summary).toBe('Detected 0 recommendation(s): 0 critical, 0 warning, 0 info.');
            expect(report.metadata).toEqual({
                queryLength: 512,
                recommendationCount: 0,
                analyzedAt: '2026-02-24T17:20:00.000Z'
            });
        });
    });
});
