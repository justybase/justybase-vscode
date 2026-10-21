import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ObjectNotesStore,
    formatObjectNotesForCopilot,
    objectNoteKey,
    objectNoteRefForItem,
    parseObjectNotesFile,
    type ObjectNoteRef,
} from '../core/objectNotesStore';

const orders: ObjectNoteRef = { connectionName: 'NZ', database: 'SALES', schema: 'ADMIN', objectType: 'TABLE', name: 'ORDERS' };
const ordersAmount: ObjectNoteRef = { ...orders, column: 'AMOUNT' };

describe('ObjectNotesStore', () => {
    let dir: string;
    let file: string;
    let clock: number;
    const createStore = () => new ObjectNotesStore(file, () => clock);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-notes-'));
        file = path.join(dir, 'nested', 'object-notes.json');
        clock = 1000;
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('starts empty when no file exists and persists notes for objects and columns', async () => {
        const store = createStore();
        await store.load();
        expect(store.all()).toEqual([]);

        await store.set(orders, '  Loaded nightly by ETL  ');
        await store.set(ordersAmount, 'Gross, in EUR');

        const reloaded = createStore();
        await reloaded.load();
        expect(reloaded.get(orders)).toEqual({ ref: orders, note: 'Loaded nightly by ETL', updatedAt: 1000 });
        expect(reloaded.get(ordersAmount)?.note).toBe('Gross, in EUR');
        expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    });

    it('removes a note when it is cleared', async () => {
        const store = createStore();
        await store.set(orders, 'temporary');
        await store.set(orders, '   ');
        expect(store.get(orders)).toBeUndefined();

        await store.remove(ordersAmount);
        const reloaded = createStore();
        await reloaded.load();
        expect(reloaded.all()).toEqual([]);
    });

    it('notifies listeners when notes change', async () => {
        const store = createStore();
        const listener = jest.fn();
        store.onDidChange(listener);

        await store.set(orders, 'note');
        await store.remove(ordersAmount);

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps the last of several quick edits', async () => {
        const store = createStore();
        await Promise.all([store.set(orders, 'first'), store.set(orders, 'second'), store.set(ordersAmount, 'column')]);

        const reloaded = createStore();
        await reloaded.load();
        expect(reloaded.get(orders)?.note).toBe('second');
        expect(reloaded.get(ordersAmount)?.note).toBe('column');
    });

    it('sets a corrupt file aside instead of overwriting it', async () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        const store = createStore();

        await store.load();
        await store.set(orders, 'fresh');

        expect(fs.readFileSync(`${file}.corrupt-1000`, 'utf8')).toBe('{ not json');
        expect(parseObjectNotesFile(fs.readFileSync(file, 'utf8')).get(objectNoteKey(orders))?.note).toBe('fresh');
    });

    it('migrates the version-0 key-to-text map', () => {
        const notes = parseObjectNotesFile(JSON.stringify({
            [objectNoteKey(orders)]: 'legacy',
            [objectNoteKey(ordersAmount)]: 'legacy column',
            'broken-key': 'ignored',
        }));

        expect(notes.get(objectNoteKey(orders))).toEqual({ ref: orders, note: 'legacy', updatedAt: 0 });
        expect(notes.get(objectNoteKey(ordersAmount))?.ref).toEqual(ordersAmount);
        expect(notes.size).toBe(2);
    });

    it('imports notes from another machine and keeps newer local ones', async () => {
        const store = createStore();
        clock = 5000;
        await store.set(orders, 'local, newer');
        const incoming = JSON.stringify({
            version: 1,
            notes: {
                a: { ref: orders, note: 'remote, older', updatedAt: 10 },
                b: { ref: ordersAmount, note: 'remote column', updatedAt: 10 },
                c: { ref: { name: 'missing fields' }, note: 'ignored', updatedAt: 10 },
            },
        });

        expect(await store.importFrom(incoming)).toBe(1);
        expect(store.get(orders)?.note).toBe('local, newer');
        expect(store.get(ordersAmount)?.note).toBe('remote column');
    });

    it('finds the notes of an object and its columns regardless of case or connection', async () => {
        const store = createStore();
        await store.set(orders, 'table');
        await store.set({ ...ordersAmount, connectionName: 'NZ_PROD' }, 'column');
        await store.set({ ...orders, name: 'CUSTOMERS' }, 'other');

        expect(store.findForObject('sales', 'admin', 'orders').map(note => note.note).sort()).toEqual(['column', 'table']);
        expect(store.findForObject('SALES', undefined, 'ORDERS')).toHaveLength(2);
    });
});

describe('objectNoteRefForItem', () => {
    it('identifies schema objects, favorites and columns', () => {
        expect(objectNoteRefForItem({ contextValue: 'netezza:TABLE', connectionName: 'NZ', dbName: 'SALES', schema: 'ADMIN', objType: 'TABLE', label: 'ORDERS' })).toEqual(orders);
        expect(objectNoteRefForItem({ contextValue: 'favoritesObject:TABLE', connectionName: 'NZ', dbName: 'SALES', schema: 'ADMIN', objType: 'TABLE', label: '★ ORDERS', rawLabel: 'ORDERS' })).toEqual(orders);
        expect(objectNoteRefForItem({ contextValue: 'column', connectionName: 'NZ', dbName: 'SALES', schema: 'ADMIN', objType: 'TABLE', parentName: 'ORDERS', label: 'AMOUNT' })).toEqual(ordersAmount);
    });

    it('ignores folders, databases and incomplete nodes', () => {
        expect(objectNoteRefForItem({ contextValue: 'typeGroup', connectionName: 'NZ', dbName: 'SALES', objType: 'TABLE', label: 'Tables' })).toBeUndefined();
        expect(objectNoteRefForItem({ contextValue: 'database', connectionName: 'NZ', dbName: 'SALES', label: 'SALES' })).toBeUndefined();
        expect(objectNoteRefForItem({ contextValue: 'column', connectionName: 'NZ', dbName: 'SALES', objType: 'TABLE', label: 'AMOUNT' })).toBeUndefined();
        expect(objectNoteRefForItem(undefined)).toBeUndefined();
    });
});

describe('formatObjectNotesForCopilot', () => {
    it('lists the table note first and flattens line breaks', () => {
        const lines = formatObjectNotesForCopilot([
            { ref: ordersAmount, note: 'Gross\nin EUR', updatedAt: 1 },
            { ref: orders, note: 'Loaded nightly', updatedAt: 1 },
        ]);

        expect(lines).toEqual([
            '',
            '### User Notes (local, not stored in the database)',
            '',
            '- **ORDERS**: Loaded nightly',
            '- Column **AMOUNT**: Gross in EUR',
        ]);
        expect(formatObjectNotesForCopilot([])).toEqual([]);
    });
});

describe('ObjectNotesStore while loading', () => {
    it('keeps an edit made before the file finished loading', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-notes-race-'));
        const file = path.join(dir, 'object-notes.json');
        try {
            fs.writeFileSync(file, JSON.stringify({ version: 1, notes: { a: { ref: ordersAmount, note: 'from disk', updatedAt: 1 } } }));
            const store = new ObjectNotesStore(file);
            const loaded = store.load();
            await store.set(orders, 'typed during load');
            await loaded;

            expect(store.get(orders)?.note).toBe('typed during load');
            expect(store.get(ordersAmount)?.note).toBe('from disk');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
