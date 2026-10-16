import { resolveDetection, type DetectionContext } from '../analytical/detectionConfig';
import { PEER_MIN_GROUPS } from '../analytical/modeRules';
import { evidenceRows } from '../analytical/explain';
import type { ResultSet } from '../types';
import type { AnomalyFlag } from '../analytical/types';

// Host-facing modules are replaced at file level so the dynamically imported panel sees the mocks.
let mockOwner: ResultSet;
let mockHostState: Record<string, unknown> = {};

jest.mock('../dom', () => ({
    getElementById: (id: string) => document.getElementById(id),
    asHtml: (value: unknown) => value,
}));
jest.mock('../types', () => ({
    getActiveSourceUri: () => 'file:///options.sql',
    getResultSetAt: () => mockOwner,
}));
jest.mock('../protocol', () => ({
    getHostState: () => mockHostState,
    setHostState: (state: Record<string, unknown>) => {
        mockHostState = state;
    },
}));
jest.mock('../diskBackedGrid', () => ({
    fetchRowsFromHost: jest.fn(async () => []),
    queryDiskGroupStats: jest.fn(),
}));

describe('resolveDetection', () => {
    const context = (overrides: Partial<DetectionContext> = {}): DetectionContext => ({
        listedGroups: 10,
        qualifyingGroups: 10,
        quantilesAvailable: false,
        ...overrides,
    });

    it('runs rest of result only with at least two listed groups', () => {
        expect(resolveDetection('rest', context()).effective).toBe('rest');
        const single = resolveDetection('rest', context({ listedGroups: 1 }));
        expect(single.effective).toBe('whole');
        expect(single.requested).toBe('rest');
        expect(single.notice).toContain('at least 2 groups');
    });

    it('keeps the whole result for default and whole choices', () => {
        expect(resolveDetection('default', context())).toMatchObject({ requested: 'default', effective: 'whole', viaAuto: false });
        expect(resolveDetection('whole', context({ listedGroups: 0 }))).toMatchObject({ effective: 'whole' });
    });

    it('auto picks peer groups only with enough qualifying groups', () => {
        expect(resolveDetection('auto', context())).toMatchObject({ effective: 'peer', viaAuto: true });
        expect(resolveDetection('auto', context({ qualifyingGroups: PEER_MIN_GROUPS - 1 }))).toMatchObject({ effective: 'whole', viaAuto: true });
    });

    it('blocks reference mode until a listed reference group is chosen', () => {
        expect(resolveDetection('reference', context())).toMatchObject({ effective: 'reference', blocked: 'needs-reference' });
        expect(resolveDetection('reference', context({ referenceKey: 'k' })).blocked).toBeUndefined();
    });

    it('falls back to whole when robust quartiles are unavailable', () => {
        expect(resolveDetection('robust', context()).effective).toBe('whole');
        expect(resolveDetection('robust', context({ quantilesAvailable: true })).effective).toBe('robust');
    });
});

describe('evidenceRows', () => {
    it('lists every evidence field in a fixed order', () => {
        const flag: AnomalyFlag = {
            rule: 'MEAN_SHIFT',
            severity: 'high',
            columnIndex: 1,
            strength: 0.8,
            message: 'x',
            evidence: {
                baseline: 'rest',
                method: 'mean shift vs rest of result',
                observed: 900,
                observedLabel: 'average in group',
                expected: 100,
                expectedLabel: 'average in baseline',
                threshold: 1,
                thresholdLabel: 'effect size',
                effect: 2.4,
                effectUnit: 'sigma',
                sampleSize: 40,
                baselineSize: 200,
                notes: ['z = 9.1'],
            },
        };
        const rows = evidenceRows(flag);
        expect(rows.map(row => row.label)).toEqual(['Method', 'Baseline', 'Observed', 'Expected', 'Threshold', 'Effect', 'Sample', 'Notes']);
        const byLabel = Object.fromEntries(rows.map(row => [row.label, row.value]));
        expect(byLabel.Baseline).toBe('rest of result');
        expect(byLabel.Sample).toBe('40 rows vs 200 in baseline');
        expect(byLabel.Notes).toBe('z = 9.1');
    });

    it('renders a missing threshold and effect as an em dash', () => {
        const flag = {
            rule: 'CONSTANT_IN_GROUP' as const,
            severity: 'info' as const,
            strength: 0.25,
            message: 'x',
            evidence: {
                baseline: 'whole' as const,
                method: 'm',
                observed: 1,
                observedLabel: 'distinct',
                expected: null,
                expectedLabel: 'baseline distinct',
                threshold: null,
                thresholdLabel: 'minimum',
                effect: null,
                effectUnit: 'values',
                sampleSize: 12,
            },
        };
        const rows = Object.fromEntries(evidenceRows(flag).map(row => [row.label, row.value]));
        expect(rows.Expected).toContain('—');
        expect(rows.Threshold).toBe('minimum');
        expect(rows.Effect).toBe('—');
        expect(rows.Sample).toBe('12 rows');
        expect(rows.Notes).toBe('—');
    });
});

describe('options panel behaviour', () => {
    const schema = [
        { index: 0, name: 'REGION', type: 'varchar' },
        { index: 1, name: 'AMOUNT', type: 'numeric' },
        { index: 2, name: 'CODE', type: 'varchar' },
    ];

    function rowsForOptions(): unknown[][] {
        const rows: unknown[][] = [];
        for (let g = 1; g <= 4; g++) {
            for (let i = 0; i < 25; i++) {
                const spike = g === 4;
                rows.push([`R${g}`, spike ? 5000 + i : 100 + (i % 4), spike ? 'Z9' : 'C1']);
            }
        }
        return rows;
    }

    function ownerWithRows(): ResultSet {
        const data = rowsForOptions();
        return {
            columns: schema,
            data,
            executionTimestamp: 7,
            sql: 'select options',
            storageSessionId: 'options-session',
            storageMode: 'memory',
            isLog: false,
            isError: false,
            resultSetId: 'rs-options',
            totalRowCount: data.length,
        } as unknown as ResultSet;
    }

    async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
        for (let attempt = 0; attempt < 200; attempt++) {
            const value = read();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Condition not reached');
    }

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '<div id="analysisContainer"></div>';
        mockHostState = {};
        mockOwner = ownerWithRows();
    });

    it('switching the detection mode persists it and re-scores the cached result', async () => {
        const panel: typeof import('../analytical/analyticalPanel') = await import('../analytical/analyticalPanel');
        panel.renderAnalyticalView(0);
        (document.querySelector('.analytical-suggestion') as HTMLButtonElement | null)?.click();
        await waitFor(() => document.querySelectorAll('.analytical-group').length > 0 || null);

        (document.querySelector('.analytical-options-root > button') as HTMLButtonElement).click();
        const modeSelect = document.querySelector<HTMLSelectElement>('#analytical-options-mode');
        expect(modeSelect).not.toBeNull();
        modeSelect!.value = 'rest';
        modeSelect!.dispatchEvent(new Event('change'));

        expect(document.querySelector('.analytical-mode')?.textContent).toContain('Rest of result');
        const saved = mockHostState._analyticalStates as Record<string, { detection: { mode: string } }>;
        expect(Object.values(saved)[0].detection.mode).toBe('rest');
        panel.disposeAnalyticalView();
    });

    it('disabling a rule removes its flags from the list without starting a new computation', async () => {
        const panel: typeof import('../analytical/analyticalPanel') = await import('../analytical/analyticalPanel');
        panel.renderAnalyticalView(0);
        (document.querySelector('.analytical-suggestion') as HTMLButtonElement | null)?.click();
        await waitFor(() => document.querySelectorAll('.analytical-group').length > 0 || null);

        const flagsBefore = document.querySelectorAll('.analytical-flag').length;
        expect(flagsBefore).toBeGreaterThan(0);

        (document.querySelector('.analytical-options-root > button') as HTMLButtonElement).click();
        const rule = Array.from(document.querySelectorAll<HTMLLabelElement>('.analytical-option-group label'))
            .find(label => label.textContent?.trim() === 'Null rate change');
        const checkbox = rule?.querySelector('input');
        expect(checkbox).toBeTruthy();
        // Disable every rule so the change is observable regardless of which rules fired.
        for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>('.analytical-option-group label'))) {
            const input = label.querySelector('input');
            if (input?.checked) {
                input.checked = false;
                input.dispatchEvent(new Event('change'));
            }
        }
        expect(document.querySelectorAll('.analytical-flag').length).toBe(0);
        panel.disposeAnalyticalView();
    });

    it('reference mode asks for a group, then persists it and marks the mode as reference', async () => {
        const panel: typeof import('../analytical/analyticalPanel') = await import('../analytical/analyticalPanel');
        panel.renderAnalyticalView(0);
        (document.querySelector('.analytical-suggestion') as HTMLButtonElement | null)?.click();
        await waitFor(() => document.querySelectorAll('.analytical-group').length > 0 || null);

        (document.querySelector('.analytical-options-root > button') as HTMLButtonElement).click();
        const modeSelect = document.querySelector<HTMLSelectElement>('#analytical-options-mode');
        modeSelect!.value = 'reference';
        modeSelect!.dispatchEvent(new Event('change'));

        const referenceSelect = document.querySelector<HTMLSelectElement>('#analytical-options-reference');
        expect(referenceSelect).not.toBeNull();
        expect(document.querySelector('.analytical-notice')?.textContent).toContain('Choose a reference group');
        const option = Array.from(referenceSelect!.options).find(item => item.textContent === 'C1');
        expect(option).toBeTruthy();
        referenceSelect!.value = option!.value;
        referenceSelect!.dispatchEvent(new Event('change'));

        expect(document.querySelector('.analytical-mode')?.textContent).toContain('Reference group');
        const saved = mockHostState._analyticalStates as Record<string, { detection: { mode: string; referenceGroupKey?: string } }>;
        expect(Object.values(saved)[0].detection).toEqual({ mode: 'reference', referenceGroupKey: option!.value });
        const referenceGroup = Array.from(document.querySelectorAll('.analytical-group')).find(node => node.textContent?.includes('C1'));
        expect(referenceGroup).toBeTruthy();
        panel.disposeAnalyticalView();
    });

    it('excluding a column removes it from the detail pane', async () => {
        const panel: typeof import('../analytical/analyticalPanel') = await import('../analytical/analyticalPanel');
        panel.renderAnalyticalView(0);
        (document.querySelector('.analytical-suggestion') as HTMLButtonElement | null)?.click();
        await waitFor(() => document.querySelectorAll('.analytical-group').length > 0 || null);
        const namesBefore = Array.from(document.querySelectorAll('.analytical-column-name')).map(node => node.textContent);
        expect(namesBefore).toContain('AMOUNT');

        (document.querySelector('.analytical-options-root > button') as HTMLButtonElement).click();
        const amount = Array.from(document.querySelectorAll<HTMLLabelElement>('.analytical-option-group label'))
            .find(label => label.textContent?.trim() === 'AMOUNT')
            ?.querySelector('input');
        expect(amount).toBeTruthy();
        amount!.checked = false;
        amount!.dispatchEvent(new Event('change'));

        const namesAfter = Array.from(document.querySelectorAll('.analytical-column-name')).map(node => node.textContent);
        expect(namesAfter).not.toContain('AMOUNT');
        panel.disposeAnalyticalView();
    });
});
