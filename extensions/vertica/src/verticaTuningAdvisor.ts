import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '@justybase/contracts';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';

function addRecommendation(output: TuningRecommendation[], recommendation: TuningRecommendation): void {
    output.push(recommendation);
}

function buildExplainText(input: DatabaseTuningAdvisorInput): string {
    if (!input.explainPlanText) {
        return '';
    }

    return input.explainPlanText.toUpperCase();
}

export class VerticaTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const explainText = buildExplainText(input);
        const recommendations: TuningRecommendation[] = [];

        if (/\bSELECT\s+\*/i.test(input.sql || '')) {
            addRecommendation(recommendations, {
                id: 'VTA-001',
                title: 'Avoid SELECT * in repeatable workloads',
                summary: 'Selecting every column increases I/O and can prevent lean projection usage.',
                severity: 'warning',
                confidence: clampConfidence(0.77),
                risk: 'medium',
                actions: [
                    'Project only the columns required by the consumer.',
                    'Re-run EXPLAIN and confirm lower storage-access cost after trimming width.',
                ],
                evidence: [{ source: 'sql_analysis', summary: 'Query contains SELECT *.' }],
            });
        }

        if (explainText.includes('BROADCAST')) {
            addRecommendation(recommendations, {
                id: 'VTA-002',
                title: 'Broadcast data movement detected',
                summary: 'The plan contains BROADCAST, which can amplify network cost on large joins.',
                severity: 'warning',
                confidence: clampConfidence(0.84),
                risk: 'high',
                actions: [
                    'Check projection segmentation and join keys to keep data colocated.',
                    'Validate whether a different projection or join order reduces broadcast activity.',
                ],
                evidence: [{ source: 'explain_plan', summary: 'EXPLAIN contains BROADCAST.' }],
            });
        }

        if (explainText.includes('RESEGMENT')) {
            addRecommendation(recommendations, {
                id: 'VTA-003',
                title: 'Resegmentation detected',
                summary: 'The plan redistributes rows between nodes before continuing execution.',
                severity: 'warning',
                confidence: clampConfidence(0.86),
                risk: 'high',
                actions: [
                    'Review segmentation expressions on the participating projections.',
                    'If the workload is stable, consider a projection that aligns with the join or aggregation keys.',
                ],
                evidence: [{ source: 'explain_plan', summary: 'EXPLAIN contains RESEGMENT.' }],
            });
        }

        if (explainText.includes('NO STATISTICS') || explainText.includes('STALE STATISTICS')) {
            addRecommendation(recommendations, {
                id: 'VTA-004',
                title: 'Statistics warning detected',
                summary: 'The plan indicates missing or stale statistics.',
                severity: 'warning',
                confidence: clampConfidence(0.9),
                risk: 'medium',
                actions: [
                    'Run ANALYZE_STATISTICS on the involved tables or projections.',
                    'Compare plan shape before and after refreshing statistics.',
                ],
                evidence: [{ source: 'explain_plan', summary: 'EXPLAIN mentions statistics quality.' }],
            });
        }

        if (explainText.includes('STORAGE ACCESS') && !explainText.includes('PREDICATE')) {
            addRecommendation(recommendations, {
                id: 'VTA-005',
                title: 'Storage access may be scanning more rows than necessary',
                summary: 'The plan shows storage access without an obvious pushed predicate.',
                severity: 'info',
                confidence: clampConfidence(0.62),
                risk: 'medium',
                actions: [
                    'Review predicate placement and whether filters can be made more selective.',
                    'Check projection sort order and segmentation for the most common access path.',
                ],
                evidence: [{ source: 'explain_plan', summary: 'EXPLAIN contains STORAGE ACCESS without PREDICATE.' }],
            });
        }

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }
}

export const verticaTuningAdvisor = new VerticaTuningAdvisor();
