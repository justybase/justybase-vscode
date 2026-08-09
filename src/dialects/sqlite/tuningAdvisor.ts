import type { DatabaseTuningAdvisor, DatabaseTuningAdvisorInput } from '../../contracts/database';
import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../services/tuning/types';

function recommendation(
    id: string,
    title: string,
    summary: string,
    severity: 'info' | 'warning' | 'critical',
    risk: 'low' | 'medium' | 'high',
    actions: string[],
    details: string,
): TuningRecommendation {
    return {
        id,
        title,
        summary,
        severity,
        confidence: clampConfidence(0.84),
        risk,
        actions,
        evidence: [{ source: 'explain_plan', summary: details }],
    };
}

export class SqliteTuningAdvisor implements DatabaseTuningAdvisor {
    public analyze(input: DatabaseTuningAdvisorInput): TuningReport {
        const plan = input.explainPlanText || '';
        const recommendations: TuningRecommendation[] = [];

        if (/\bSCAN\s+(?:TABLE\s+)?[\w"`.[\]]+/i.test(plan) && !/USING\s+(?:COVERING\s+)?INDEX/i.test(plan)) {
            recommendations.push(recommendation(
                'SLTA-001',
                'Full table scan detected',
                'SQLite is scanning a table without reporting an index search.',
                'warning',
                'medium',
                ['Check predicates used by the query.', 'Add an index only when it matches a selective and frequently used predicate.'],
                'EXPLAIN QUERY PLAN contains SCAN without USING INDEX.',
            ));
        }

        if (/USE\s+TEMP\s+B-TREE/i.test(plan)) {
            recommendations.push(recommendation(
                'SLTA-002',
                'Temporary B-tree used',
                'SQLite is materializing a temporary B-tree for sorting, grouping or distinct processing.',
                'warning',
                'medium',
                ['Review ORDER BY, GROUP BY and DISTINCT columns.', 'Consider an index that matches the required ordering or grouping.'],
                'EXPLAIN QUERY PLAN contains USE TEMP B-TREE.',
            ));
        }

        if (/AUTOMATIC\s+INDEX/i.test(plan)) {
            recommendations.push(recommendation(
                'SLTA-003',
                'Automatic index created',
                'SQLite created a transient automatic index for this query.',
                'info',
                'low',
                ['If this query is frequent, consider a persistent index matching the join or filter predicate.'],
                'EXPLAIN QUERY PLAN contains AUTOMATIC INDEX.',
            ));
        }

        if (/\bSELECT\s+\*/i.test(input.sql || '')) {
            recommendations.push(recommendation(
                'SLTA-004',
                'Avoid SELECT *',
                'The query requests every column from the selected source.',
                'info',
                'low',
                ['Project only the columns needed by the consumer.'],
                'SQL text contains SELECT *.',
            ));
        }

        return createTuningReport(recommendations, input.sql?.length ?? 0);
    }
}

export const sqliteTuningAdvisor: DatabaseTuningAdvisor = new SqliteTuningAdvisor();
