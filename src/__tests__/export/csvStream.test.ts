import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGunzip, createZstdDecompress } from 'zlib';
import {
    createCsvFileWriter,
    csvExtensionForCompression,
    resolveCsvCompressionFromPath,
} from '../../export/csvStream';

async function readTextFile(filePath: string): Promise<string> {
    const compression = resolveCsvCompressionFromPath(filePath);
    if (compression === 'none') {
        return fs.readFile(filePath, 'utf8');
    }

    const compressed = await fs.readFile(filePath);
    const decompressor = compression === 'gzip' ? createGunzip() : createZstdDecompress();
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
        decompressor.on('data', chunk => chunks.push(Buffer.from(chunk)));
        decompressor.once('error', reject);
        decompressor.once('end', () => resolve());
        decompressor.end(compressed);
    });

    return Buffer.concat(chunks).toString('utf8');
}

describe('csvStream', () => {
    it('resolves compression from file extension', () => {
        expect(resolveCsvCompressionFromPath('/tmp/data.csv')).toBe('none');
        expect(resolveCsvCompressionFromPath('/tmp/data.CSV.GZ')).toBe('gzip');
        expect(resolveCsvCompressionFromPath('/tmp/data.csv.zst')).toBe('zstd');
        expect(csvExtensionForCompression('gzip')).toBe('csv.gz');
        expect(csvExtensionForCompression('zstd')).toBe('csv.zst');
    });

    it.each([
        ['gzip', 'export.csv.gz'],
        ['zstd', 'export.csv.zst'],
    ] as const)('streams %s-compressed CSV end-to-end', async (compression, fileName) => {
        const filePath = path.join(os.tmpdir(), `csv-stream-${compression}-${Date.now()}-${fileName}`);
        const csvWriter = createCsvFileWriter(filePath, compression);

        try {
            const payload = 'id,name\n1,alpha\n2,beta\n';
            const canWrite = csvWriter.stream.write(payload);
            if (!canWrite) {
                await new Promise<void>(resolve => csvWriter.stream.once('drain', resolve));
            }
            await csvWriter.finalize();

            const text = await readTextFile(filePath);
            expect(text).toBe(payload);
        } finally {
            await fs.unlink(filePath).catch(() => undefined);
        }
    });
});
