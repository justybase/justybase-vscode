import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    exportStructuredToParquet,
    type StructuredExportItem,
} from '../../export/parquetExporter';
import { readParquetFile } from '../../export/parquetHyparquet';

describe('parquetHyparquet', () => {
    it('round-trips structured export through hyparquet read/write', async () => {
        const outputPath = path.join(os.tmpdir(), `hyparquet-roundtrip-${Date.now()}.parquet`);
        const items: StructuredExportItem[] = [
            {
                name: 'Sheet1',
                columns: [
                    { name: 'id', type: 'INTEGER' },
                    { name: 'label', type: 'VARCHAR' },
                    { name: 'active', type: 'BOOLEAN' },
                ],
                rows: [
                    [1, 'alpha', true],
                    [2, null, false],
                ],
            },
        ];

        try {
            const exportResult = await exportStructuredToParquet(items, outputPath);
            expect(exportResult.success).toBe(true);

            const readResult = await readParquetFile(outputPath);
            expect(readResult.totalRows).toBe(2);
            expect(readResult.columns.map(c => c.name)).toEqual(['id', 'label', 'active']);
            expect(readResult.rows).toEqual([
                [1, 'alpha', true],
                [2, null, false],
            ]);
        } finally {
            await fs.unlink(outputPath).catch(() => undefined);
        }
    });
});
