import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createClipboardImportSource,
    removeAbandonedClipboardImportSources,
} from '../import/clipboardImportSource';

describe('clipboard import source cleanup', () => {
    let storageDirectory: string;

    beforeEach(async () => {
        storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-clipboard-'));
    });

    afterEach(async () => {
        await fs.rm(storageDirectory, { recursive: true, force: true });
    });

    it('removes abandoned clipboard snapshots on startup', async () => {
        const snapshot = await createClipboardImportSource(storageDirectory, 'id\tname\n1\tAda');
        const unrelatedFile = path.join(storageDirectory, 'keep.txt');
        await fs.writeFile(unrelatedFile, 'keep');

        await removeAbandonedClipboardImportSources(storageDirectory);

        await expect(fs.access(snapshot.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.readFile(unrelatedFile, 'utf8')).resolves.toBe('keep');
        await expect(fs.access(path.join(storageDirectory, 'clipboard-imports')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is a no-op when no previous clipboard snapshots exist', async () => {
        await expect(removeAbandonedClipboardImportSources(storageDirectory)).resolves.toBeUndefined();
    });
});
