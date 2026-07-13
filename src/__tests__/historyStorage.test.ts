import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HistoryStorage } from '../core/history/historyStorage';
import { QueryHistoryEntry } from '../core/history/types';

describe('HistoryStorage', () => {
    let storagePath: string;
    let storage: HistoryStorage;

    const sampleEntry: QueryHistoryEntry = {
        id: '1',
        query: 'SELECT 1',
        timestamp: Date.now(),
        host: 'localhost',
        database: 'db',
        schema: 'public'
    };

    beforeEach(() => {
        storagePath = path.join(os.tmpdir(), `history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(storagePath, { recursive: true });
        storage = new HistoryStorage(storagePath);
    });

    afterEach(async () => {
        await storage.clearAll();
        if (fs.existsSync(storagePath)) {
            fs.rmSync(storagePath, { recursive: true, force: true });
        }
    });

    it('should save and load active entries', async () => {
        const entries = [sampleEntry];
        await storage.saveActive(entries);
        const loaded = await storage.loadActive();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].query).toBe('SELECT 1');
    });

    it('should handle atomic writes with rapid saves', async () => {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(storage.saveActive([{ ...sampleEntry, id: i.toString() }]));
        }
        await Promise.all(promises);
        const loaded = await storage.loadActive();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].id).toBe('9'); // Last one wins because they are queued
    });

    it('should migrate from JSON if msgpack does not exist', async () => {
        const jsonPath = path.join(storagePath, 'query-history.json');
        const entries = [sampleEntry];
        fs.writeFileSync(jsonPath, JSON.stringify({ entries, version: 1 }));

        const loaded = await storage.loadActive();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].query).toBe('SELECT 1');
        expect(fs.existsSync(jsonPath)).toBe(false); // Should be deleted after migration
        expect(fs.existsSync(path.join(storagePath, 'query-history.msgpack.gz'))).toBe(true);
    });

    it('should handle concurrent migration gracefully', async () => {
        const jsonPath = path.join(storagePath, 'query-history.json');
        const entries = [sampleEntry];
        fs.writeFileSync(jsonPath, JSON.stringify({ entries, version: 1 }));

        // Trigger multiple loads at once
        const [res1, res2, res3] = await Promise.all([
            storage.loadActive(),
            storage.loadActive(),
            storage.loadActive()
        ]);

        expect(res1).toHaveLength(1);
        expect(res2).toHaveLength(1);
        expect(res3).toHaveLength(1);
        expect(fs.existsSync(jsonPath)).toBe(false);
    });

    it('should append to archive and respect queue', async () => {
        await storage.saveActive([sampleEntry]);
        await storage.appendToArchive([sampleEntry]);

        const archive = await storage.getArchiveEntries();
        expect(archive).toHaveLength(1);

        const entry2 = { ...sampleEntry, id: '2' };
        await Promise.all([
            storage.appendToArchive([entry2]),
            storage.getArchiveEntries()
        ]);

        const finalArchive = await storage.getArchiveEntries();
        expect(finalArchive).toHaveLength(2);
    });

    it('uses archive metadata for repeated and concurrent stats reads', async () => {
        await storage.appendToArchive([sampleEntry]);
        const archiveReadSpy = jest.spyOn(storage, 'getArchiveEntries');

        const [first, second, third] = await Promise.all([
            storage.getStats(3),
            storage.getStats(3),
            storage.getStats(3),
        ]);

        expect(first.archivedEntries).toBe(1);
        expect(second.archivedEntries).toBe(1);
        expect(third.archivedEntries).toBe(1);
        expect(archiveReadSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(storagePath, 'query-history-archive.meta.json'))).toBe(true);
    });

    it('backfills missing archive metadata only once', async () => {
        await storage.appendToArchive([sampleEntry]);
        const metadataPath = path.join(storagePath, 'query-history-archive.meta.json');
        fs.unlinkSync(metadataPath);

        const restartedStorage = new HistoryStorage(storagePath);
        const archiveReadSpy = jest.spyOn(restartedStorage, 'getArchiveEntries');
        const [first, second] = await Promise.all([
            restartedStorage.getStats(0),
            restartedStorage.getStats(0),
        ]);

        expect(first.archivedEntries).toBe(1);
        expect(second.archivedEntries).toBe(1);
        expect(archiveReadSpy).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(metadataPath)).toBe(true);
    });

    it('should handle corrupted files gracefully', async () => {
        const msgpackPath = path.join(storagePath, 'query-history.msgpack.gz');
        fs.writeFileSync(msgpackPath, Buffer.from('not a valid gzip/msgpack file'));

        const loaded = await storage.loadActive();
        expect(loaded).toEqual([]); // Should return empty instead of crashing
    });

    it('should filter old entries from archive', async () => {
        const ancientDate = Date.now() - (1000 * 24 * 60 * 60 * 1000); // 1000 days ago
        const oldEntry = { ...sampleEntry, timestamp: ancientDate };

        await storage.appendToArchive([oldEntry, sampleEntry]);
        const archive = await storage.getArchiveEntries();

        // MAX_ARCHIVE_AGE_DAYS is 730, so oldEntry should be filtered
        expect(archive).toHaveLength(1);
        expect(archive[0].timestamp).toBeGreaterThan(ancientDate);
    });
});
