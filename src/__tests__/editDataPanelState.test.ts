import {
    buildChanges,
    buildValuePredicate,
    classifyType,
    coerceForColumn,
    createState,
    cycleSort,
    duplicateRow,
    hasPendingChanges,
    insertRow,
    revertAll,
    revertCell,
    revertRow,
    setCellValue,
    summarizeChanges,
    toggleDelete,
    typeBadge,
} from '../../media/editDataPanel/state';
import type { EditDataColumnMetadata } from '../../media/editDataPanel/hostContracts';

const META: EditDataColumnMetadata[] = [
    { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER', IS_NOT_NULL: 1, COLDEFAULT: null, DESCRIPTION: '', IS_PK: 1, IS_FK: 0 },
    { ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(50)', IS_NOT_NULL: 0, COLDEFAULT: null, DESCRIPTION: 'Label', IS_PK: 0, IS_FK: 0 },
    { ATTNAME: 'AMOUNT', FORMAT_TYPE: 'NUMERIC(12,2)', IS_NOT_NULL: 0, COLDEFAULT: null, DESCRIPTION: '', IS_PK: 0, IS_FK: 0 },
];

function sample() {
    return createState(
        [
            { ROWID: 101, ID: 1, NAME: 'b', AMOUNT: 10 },
            { ROWID: 102, ID: 2, NAME: null, AMOUNT: 2 },
            { ROWID: 103, ID: 3, NAME: 'a', AMOUNT: 30 },
        ],
        ['ROWID', 'ID', 'NAME', 'AMOUNT'],
        META,
    );
}

describe('editDataPanel state', () => {
    it('derives column metadata and keeps ROWID read-only', () => {
        const state = sample();
        expect(state.columns.map(c => [c.name, c.family, c.readonly])).toEqual([
            ['ROWID', 'number', true],
            ['ID', 'number', false],
            ['NAME', 'text', false],
            ['AMOUNT', 'number', false],
        ]);
        expect(state.columns[1].isPk).toBe(true);
        expect(state.columns[1].notNull).toBe(true);
        expect(state.columns[2].comment).toBe('Label');
    });

    it('classifies types and builds Results-style badges', () => {
        expect(classifyType('TIMESTAMP')).toBe('date');
        expect(classifyType('CHARACTER VARYING(10)')).toBe('text');
        expect(classifyType('BOOLEAN')).toBe('bool');
        expect(classifyType('DOUBLE PRECISION')).toBe('number');
        expect(typeBadge('VARCHAR(255)')).toBe('VARC');
        expect(typeBadge('')).toBe('');
    });

    it('tracks a modified cell and clears it when the value returns to the original', () => {
        const state = sample();
        expect(setCellValue(state, 'r:101', 'NAME', 'x')).toBe(true);
        expect(state.rows.get('r:101')?.modified.has('NAME')).toBe(true);
        expect(buildChanges(state).updates).toEqual([{ rowId: 101, changes: { NAME: 'x' } }]);

        setCellValue(state, 'r:101', 'NAME', 'b');
        expect(state.rows.get('r:101')?.modified.size).toBe(0);
        expect(hasPendingChanges(state)).toBe(false);
    });

    it('treats an empty edit of a NULL cell as unchanged', () => {
        const state = sample();
        setCellValue(state, 'r:102', 'NAME', '');
        expect(hasPendingChanges(state)).toBe(false);
    });

    it('rejects edits to read-only columns and deleted rows', () => {
        const state = sample();
        expect(setCellValue(state, 'r:101', 'ROWID', 5)).toBe(false);
        toggleDelete(state, ['r:101']);
        expect(setCellValue(state, 'r:101', 'NAME', 'x')).toBe(false);
    });

    it('sends numeric edits as numbers only when the conversion is lossless', () => {
        const state = sample();
        const amount = state.columns[3];
        expect(coerceForColumn('12.5', amount)).toBe(12.5);
        expect(coerceForColumn('12.50', amount)).toBe('12.50');
        expect(coerceForColumn('12345678901234567890', amount)).toBe('12345678901234567890');
        expect(coerceForColumn('abc', amount)).toBe('abc');
        expect(coerceForColumn('12', state.columns[2])).toBe('12');

        setCellValue(state, 'r:101', 'AMOUNT', '42');
        expect(buildChanges(state).updates).toEqual([{ rowId: 101, changes: { AMOUNT: 42 } }]);
    });

    it('inserts, duplicates and discards new rows', () => {
        const state = sample();
        const key = insertRow(state, 0);
        expect(state.order).toEqual(['r:101', key, 'r:102', 'r:103']);
        setCellValue(state, key, 'NAME', 'new');
        const copy = duplicateRow(state, 'r:103');
        expect(copy).not.toBeNull();
        expect(state.rows.get(copy!)?.values).toEqual({ ID: 3, NAME: 'a', AMOUNT: 30 });

        const changes = buildChanges(state);
        expect(changes.inserts).toEqual([{ NAME: 'new' }, { ID: 3, NAME: 'a', AMOUNT: 30 }]);

        toggleDelete(state, [key]);
        expect(state.rows.has(key)).toBe(false);
        expect(state.order).not.toContain(key);
    });

    it('toggles deletion for a selection and restores edited values', () => {
        const state = sample();
        setCellValue(state, 'r:101', 'NAME', 'x');
        toggleDelete(state, ['r:101', 'r:102']);
        expect(buildChanges(state).deletes).toEqual([101, 102]);
        expect(buildChanges(state).updates).toEqual([]);
        expect(state.rows.get('r:101')?.values.NAME).toBe('b');

        toggleDelete(state, ['r:101', 'r:102']);
        expect(hasPendingChanges(state)).toBe(false);
    });

    it('summarizes and reverts pending changes', () => {
        const state = sample();
        setCellValue(state, 'r:101', 'NAME', 'x');
        setCellValue(state, 'r:101', 'AMOUNT', '11');
        toggleDelete(state, ['r:103']);
        insertRow(state, -1);
        expect(summarizeChanges(state)).toEqual({ modifiedRows: 1, modifiedCells: 2, inserted: 1, deleted: 1, total: 3 });

        expect(revertCell(state, 'r:101', 'AMOUNT')).toBe(true);
        expect(state.rows.get('r:101')?.values.AMOUNT).toBe(10);
        expect(revertRow(state, 'r:103')).toBe(true);
        revertAll(state);
        expect(hasPendingChanges(state)).toBe(false);
        expect(state.order).toEqual(['r:101', 'r:102', 'r:103']);
    });

    it('cycles client-side sort with NULLs last and restores load order', () => {
        const state = sample();
        cycleSort(state, 'NAME');
        expect(state.order).toEqual(['r:103', 'r:101', 'r:102']);
        cycleSort(state, 'NAME');
        expect(state.order).toEqual(['r:102', 'r:101', 'r:103']);
        cycleSort(state, 'NAME');
        expect(state.sort).toBeNull();
        expect(state.order).toEqual(['r:101', 'r:102', 'r:103']);

        cycleSort(state, 'AMOUNT');
        expect(state.order).toEqual(['r:102', 'r:101', 'r:103']);
    });

    it('keeps inserted rows on top of a sorted view', () => {
        const state = sample();
        cycleSort(state, 'AMOUNT');
        const key = insertRow(state, 2);
        cycleSort(state, 'AMOUNT');
        expect(state.order[0]).toBe(key);
    });

    it('builds filter-by-value predicates with escaped literals', () => {
        const state = sample();
        expect(buildValuePredicate(state.columns[2], "O'Brien", 'NAME')).toBe("NAME = 'O''Brien'");
        expect(buildValuePredicate(state.columns[1], 5, 'ID')).toBe('ID = 5');
        expect(buildValuePredicate(state.columns[2], null, 'NAME')).toBe('NAME IS NULL');
    });
});
