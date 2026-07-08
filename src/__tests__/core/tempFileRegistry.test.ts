import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tempFileRegistry } from '../../core/tempFileRegistry';

describe('tempFileRegistry', () => {
    const tempPaths: string[] = [];

    afterEach(() => {
        tempFileRegistry.disposeAll();
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore
            }
        }
    });

    it('tracks and deletes registered files', () => {
        const filePath = path.join(os.tmpdir(), `justybase-results-test-${Date.now()}.db`);
        fs.writeFileSync(filePath, 'test');
        tempPaths.push(filePath);

        tempFileRegistry.register('store-1', filePath);
        tempFileRegistry.deleteFile('store-1');

        expect(fs.existsSync(filePath)).toBe(false);
    });
});
