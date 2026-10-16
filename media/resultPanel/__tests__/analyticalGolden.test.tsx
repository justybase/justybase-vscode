// Characterisation test for the Analytical engine and the whole-result rules. It freezes flags,
// messages and scores produced today so later phases can prove that default behaviour is unchanged.

import { applyAnomalies } from '../analytical/anomalyRules';
import { computeGroupStatsSync } from '../analytical/computeGroupStats';
import type { AnalyticalDataset, AnalyticalSensitivity } from '../analytical/types';

const COLUMNS = [
    { index: 0, name: 'REGION', role: 'dimension' as const },
    { index: 1, name: 'AMOUNT', role: 'measure' as const },
    { index: 2, name: 'STATUS', role: 'dimension' as const },
    { index: 3, name: 'DAY', role: 'date' as const },
    { index: 4, name: 'NOTE', role: 'dimension' as const },
];

function buildRows(): unknown[][] {
    const rows: unknown[][] = [];
    for (let i = 0; i < 300; i++) {
        const region = ['EMEA', 'US', 'APAC', 'LATAM', 'SPIKE', 'CONST', 'WIDE', 'SMALL'][i % 8];
        if (region === 'SMALL' && i > 40) continue;
        const spike = region === 'SPIKE';
        const wide = region === 'WIDE';
        rows.push([
            region,
            spike ? 5000 + (i % 7) : wide ? (i * 977) % 20000 : 100 + ((i * 13) % 11),
            region === 'CONST' ? 'OK' : spike || (i % 5 === 0) ? 'ERR' : i % 11 === 0 ? 'WARN' : 'OK',
            region === 'EMEA' && i > 150
                ? `2024-${String(1 + (i % 3)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`
                : `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
            region === 'LATAM' ? null : (i % 9 === 0 ? 'x' : 'y'),
        ]);
    }
    return rows;
}

/** Stable, comparison-friendly projection of a scored dataset. Excludes fields that later phases add. */
function summarize(dataset: AnalyticalDataset) {
    return {
        totalRows: dataset.totalRows,
        totalGroups: dataset.totalGroups,
        groups: dataset.groups.map(group => ({
            key: group.key,
            rowCount: group.rowCount,
            score: group.score,
            anomalous: group.anomalous,
            flags: group.flags.map(flag => ({
                rule: flag.rule,
                columnIndex: flag.columnIndex ?? null,
                severity: flag.severity,
                strength: Number(flag.strength.toFixed(10)),
                message: flag.message,
            })),
        })),
    };
}

describe('Analytical whole-result behaviour (characterisation)', () => {
    const rows = buildRows();
    const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });

    // MIX_SHIFT arrived after this snapshot was taken; disabling it keeps the snapshot a check on the original rules.
    it.each<AnalyticalSensitivity>(['low', 'normal', 'high'])('freezes scoring at %s sensitivity', sensitivity => {
        const scored = applyAnomalies(dataset, { sensitivity, minGroupRows: 5, disabledRules: ['MIX_SHIFT'] });
        expect(summarize(scored)).toMatchSnapshot();
    });

    it('adds MIX_SHIFT flags on top of the frozen rules when it is enabled', () => {
        const scored = applyAnomalies(dataset, { sensitivity: 'high', minGroupRows: 5 });
        const mixRules = scored.groups.flatMap(group => group.flags.filter(flag => flag.rule === 'MIX_SHIFT'));
        expect(mixRules.length).toBeGreaterThan(0);
        for (const flag of mixRules) {
            expect(flag.evidence.baseline).toBe('whole');
        }
    });

    it('freezes the population statistics the rules compare against', () => {
        expect(dataset.population.map(column => ({
            columnIndex: column.columnIndex,
            rowCount: column.rowCount,
            nullCount: column.nullCount,
            distinctCount: column.distinctCount,
            numericCount: column.numeric?.count ?? null,
        }))).toMatchSnapshot();
    });
});
