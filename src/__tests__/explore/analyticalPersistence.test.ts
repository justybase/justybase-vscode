import {
    analyticalSchemaKey,
    loadAnalyticalState,
    sanitizeAnalyticalState,
    saveAnalyticalState,
} from '../../../media/resultPanel/analytical/analyticalPersistence.js';
import { createDefaultAnalyticalState, type AnalyticalPersistedState } from '../../../media/resultPanel/analytical/types.js';

const columns = [{ name: 'CATEGORY' }, { name: 'AMOUNT' }, { name: 'DAY' }];
const schemaKey = analyticalSchemaKey(columns);

function savedState(overrides: Partial<AnalyticalPersistedState> = {}): AnalyticalPersistedState {
    return {
        ...createDefaultAnalyticalState(),
        schemaKey,
        groupColumns: [{ index: 0, name: 'CATEGORY' }],
        sensitivity: 'high',
        minGroupRows: 12,
        sort: { key: 'score', desc: false },
        detection: { mode: 'reference', referenceGroupKey: '["A"]' },
        disabledRules: ['MEAN_SHIFT'],
        excludedColumns: [{ index: 2, name: 'DAY' }],
        anomaliesOnly: true,
        selectedGroupKey: '["A"]',
        ...overrides,
    };
}

describe('analytical persistence', () => {
    it('round-trips validated options per result', () => {
        const state = savedState();
        const store = saveAnalyticalState({}, 'file:///query.sql#0', state);
        expect(loadAnalyticalState(store, 'file:///query.sql#0', columns, schemaKey)).toEqual(state);
    });

    it('drops options when the result schema changes', () => {
        const store = saveAnalyticalState({}, 'key', savedState());
        const changed = analyticalSchemaKey([{ name: 'CATEGORY' }, { name: 'AMOUNT' }]);
        expect(sanitizeAnalyticalState(store.key, columns, changed)).toMatchObject({
            schemaKey: changed,
            groupColumns: [],
            excludedColumns: [],
            sensitivity: 'normal',
            detection: { mode: 'default' },
        });
    });

    it('removes stale columns, invalid rules and out-of-range values', () => {
        const state = sanitizeAnalyticalState({
            version: 2,
            schemaKey,
            groupColumns: [{ index: 0, name: 'CATEGORY' }, { index: 0, name: 'CATEGORY' }, { index: 9, name: 'GHOST' }],
            excludedColumns: [{ index: 2, name: 'DAY' }, { index: 0, name: 'CATEGORY' }, { index: 7, name: 'GHOST' }],
            sensitivity: 'extreme',
            minGroupRows: 0,
            sort: { key: 'bogus', desc: 'yes' },
            detection: { mode: 'bogus', referenceGroupKey: '["A"]' },
            disabledRules: ['MEAN_SHIFT', 'NOT_A_RULE'],
            anomaliesOnly: 'yes',
        }, columns, schemaKey);

        expect(state).toMatchObject({
            groupColumns: [{ index: 0, name: 'CATEGORY' }],
            excludedColumns: [{ index: 2, name: 'DAY' }],
            sensitivity: 'normal',
            minGroupRows: 1,
            sort: { key: 'size', desc: true },
            detection: { mode: 'default' },
            disabledRules: ['MEAN_SHIFT'],
            anomaliesOnly: false,
        });
    });

    it('returns defaults for a missing entry and keeps the active entry when pruning', () => {
        expect(loadAnalyticalState(undefined, 'missing', columns, schemaKey)).toMatchObject({
            version: 2,
            schemaKey,
            groupColumns: [],
        });

        let store: Record<string, AnalyticalPersistedState> = {};
        for (let index = 0; index < 60; index += 1) {
            store = saveAnalyticalState(store, `key-${index}`, savedState(), 50);
        }
        store = saveAnalyticalState(store, 'active', savedState(), 50);
        expect(Object.keys(store)).toHaveLength(50);
        expect(store.active).toBeDefined();
        expect(store['key-6']).toBeUndefined();
    });
});
