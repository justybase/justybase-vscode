import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    getDroppedImportDirectory,
    removeAbandonedDroppedImportSources,
    removeDroppedImportSource,
    stageDroppedImportSource,
} from '../import/droppedImportSource';

describe('dropped import source staging', () => {
    let storageDirectory: string;

    beforeEach(async () => {
        storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-import-drop-'));
    });

    afterEach(async () => {
        await fs.rm(storageDirectory, { recursive: true, force: true });
    });

    it('stages dropped bytes under the private storage directory', async () => {
        const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
        const filePath = await stageDroppedImportSource(storageDirectory, 'orders.xlsx', bytes);

        expect(filePath.startsWith(`${getDroppedImportDirectory(storageDirectory)}${path.sep}`)).toBe(true);
        await expect(fs.readFile(filePath)).resolves.toEqual(bytes);
    });

    it('removes only files inside the staging directory', async () => {
        const filePath = await stageDroppedImportSource(storageDirectory, 'orders.csv', Buffer.from('id'));
        const unrelatedFile = path.join(storageDirectory, 'keep.txt');
        await fs.writeFile(unrelatedFile, 'keep');

        await removeDroppedImportSource(storageDirectory, unrelatedFile);
        await removeDroppedImportSource(storageDirectory, filePath);

        await expect(fs.readFile(unrelatedFile, 'utf8')).resolves.toBe('keep');
        await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('removes abandoned dropped files but keeps fresh ones', async () => {
        const oldFile = await stageDroppedImportSource(storageDirectory, 'old.csv', Buffer.from('old'));
        const freshFile = await stageDroppedImportSource(storageDirectory, 'fresh.csv', Buffer.from('fresh'));
        const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
        await fs.utimes(oldFile, oldTime, oldTime);

        await removeAbandonedDroppedImportSources(storageDirectory);

        await expect(fs.access(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.readFile(freshFile, 'utf8')).resolves.toBe('fresh');
    });

    it('is a no-op when no staging directory exists', async () => {
        await expect(removeAbandonedDroppedImportSources(storageDirectory)).resolves.toBeUndefined();
    });
});
