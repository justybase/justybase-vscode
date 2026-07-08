import { NetezzaTuningAdvisor } from '../services/tuning/netezzaTuningAdvisor';

describe('services/tuning/netezzaTuningAdvisor', () => {
    const advisor = new NetezzaTuningAdvisor();

    it('returns no recommendations for balanced evidence', () => {
        const explain = `
l: Hash Join (cost=10.0..1500.0 rows=5000 width=64 conf=75)
l: Index Scan table "ORDERS" (cost=5.0..200.0 rows=2000 width=32 conf=85)
        `.trim();

        const tableStats = `
## Table Statistics: DB1.ADMIN.ORDERS
**Row Count:** 200000
**Distribution Key:** ORDER_ID
**Skew Ratio:** 8.5%
✅ Data distribution looks balanced.
        `.trim();

        const report = advisor.analyze({
            sql: 'SELECT order_id, customer_id FROM admin.orders WHERE order_id > 100 LIMIT 100',
            explainPlanText: explain,
            tableStatsText: tableStats
        });

        expect(report.recommendations).toHaveLength(0);
        expect(report.summary).toContain('Detected 0 recommendation(s)');
    });

    it('detects high skew ratio recommendation', () => {
        const report = advisor.analyze({
            sql: 'SELECT order_id FROM admin.orders',
            tableStatsText: `
**Distribution Key:** ORDER_ID
**Skew Ratio:** 42.7%
            `.trim()
        });

        const recommendation = report.recommendations.find(r => r.id === 'NZTA-005');
        expect(recommendation).toBeDefined();
        expect(recommendation?.severity).toBe('critical');
        expect(recommendation?.risk).toBe('high');
    });

    it('detects low confidence explain recommendation (missing stats signal)', () => {
        const report = advisor.analyze({
            sql: 'SELECT order_id FROM admin.orders',
            explainPlanText: `
l: Sequential Scan table "ORDERS" (cost=15.0..5000.0 rows=90000 width=32 conf=0)
            `.trim()
        });

        const recommendation = report.recommendations.find(r => r.id === 'NZTA-004');
        expect(recommendation).toBeDefined();
        expect(recommendation?.actions.join(' ')).toContain('GENERATE STATISTICS');
    });

    it('detects mixed evidence recommendations from SQL, explain and table stats', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM admin.orders o JOIN admin.customers c ON o.customer_id = c.customer_id',
            explainPlanText: `
l: Nested Loop (cost=100.0..15000000.0 rows=250000 width=128 conf=0)
l: Sequential Scan table "ORDERS" (cost=20.0..1000.0 rows=200000 width=64 conf=10)
            `.trim(),
            tableStatsText: `
**Distribution Key:** RANDOM
**Skew Ratio:** 35.0%
Could not retrieve distribution data.
            `.trim()
        });

        const ids = report.recommendations.map(r => r.id);
        expect(ids).toContain('NZTA-001'); // SELECT *
        expect(ids).toContain('NZTA-002'); // Nested Loop high rows
        expect(ids).toContain('NZTA-003'); // High cost
        expect(ids).toContain('NZTA-004'); // Low confidence
        expect(ids).toContain('NZTA-005'); // High skew
        expect(ids).toContain('NZTA-006'); // RANDOM distribution
        expect(ids).toContain('NZTA-007'); // Missing distribution details
    });

    it('parses commas and decimal separators in stats values', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM admin.t',
            tableStatsText: `
**Row Count:** 1,234,567
**Distribution Key:** ID
**Skew Ratio:** 20,5%
            `.trim()
        });

        const skewRecommendation = report.recommendations.find(r => r.id === 'NZTA-005');
        expect(skewRecommendation).toBeDefined();
    });
});
