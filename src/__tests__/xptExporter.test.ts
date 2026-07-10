/**
 * Tests for XPORT v5 exporter (xptExporter.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportStructuredToXpt } from '../export/xptExporter';
import { ibmDoubleToIeee } from '../export/xptIEEE754';

// Helper: make a temp file path.
function tmpPath(): string {
    return path.join(os.tmpdir(), `test_xpt_${Date.now()}_${Math.random().toString(36).slice(2)}.xpt`);
}

// Cleanup helper.
function cleanup(p: string) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
}

describe('xptExporter', () => {
    describe('exportStructuredToXpt', () => {
        it('exports simple data with numeric and character columns', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    {
                        columns: [
                            { name: 'ID', type: 'INTEGER' },
                            { name: 'NAME', type: 'VARCHAR(20)' },
                            { name: 'VALUE', type: 'DOUBLE' },
                        ],
                        rows: [
                            [1, 'Alice', 100.5],
                            [2, 'Bob', 200.75],
                            [3, 'Charlie', 300.0],
                        ],
                        name: 'TEST',
                    },
                ], outputPath, false);

                expect(result.success).toBe(true);
                expect(result.details?.rows_exported).toBe(3);
                expect(result.details?.columns).toBe(3);
                expect(fs.existsSync(outputPath)).toBe(true);

                // Verify file size is a multiple of 80
                const stat = fs.statSync(outputPath);
                expect(stat.size % 80).toBe(0);
                expect(stat.size).toBeGreaterThan(0);
            } finally {
                cleanup(outputPath);
            }
        });

        it('handles null and missing values', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    {
                        columns: [
                            { name: 'A', type: 'INTEGER' },
                            { name: 'B', type: 'VARCHAR(10)' },
                        ],
                        rows: [
                            [null, null],
                            [42, 'hello'],
                            [null, 'world'],
                        ],
                        name: 'NULLTEST',
                    },
                ], outputPath, false);

                expect(result.success).toBe(true);
                expect(result.details?.rows_exported).toBe(3);
            } finally {
                cleanup(outputPath);
            }
        });

        it('returns error when there are no columns', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    { columns: [], rows: [], name: 'EMPTY' },
                ], outputPath, false);
                expect(result.success).toBe(false);
                expect(result.message).toContain('no columns');
            } finally {
                cleanup(outputPath);
            }
        });

        it('skips unsupported BLOB columns with warning', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    {
                        columns: [
                            { name: 'ID', type: 'INTEGER' },
                            { name: 'DATA', type: 'BLOB' },
                        ],
                        rows: [
                            [1, Buffer.from([0, 1, 2])],
                        ],
                        name: 'BLOBTEST',
                    },
                ], outputPath, false);

                // Should succeed with only the ID column
                expect(result.success).toBe(true);
                expect(result.details?.columns).toBe(1);
            } finally {
                cleanup(outputPath);
            }
        });

        it('produces valid header records (first 3 records of 80 bytes each)', async () => {
            const outputPath = tmpPath();
            try {
                await exportStructuredToXpt([
                    {
                        columns: [{ name: 'X', type: 'INTEGER' }],
                        rows: [[1]],
                        name: 'TEST',
                    },
                ], outputPath, false);

                const buf = fs.readFileSync(outputPath);

                // Record 1: Library header (first 36 chars = header ID, then SAS version, OS, dates)
                const rec1 = buf.slice(0, 80).toString('ascii');
                expect(rec1.slice(0, 36)).toBe('HEADER RECORD*******LIBRARY HEADER R');
                expect(rec1).toMatch(/SAS\s+/); // SAS version present
                expect(rec1).toMatch(/\d{2}[A-Z]{3}\d{2}/); // date present

                // Record 2: Member header
                const rec2 = buf.slice(80, 160).toString('ascii');
                expect(rec2.slice(0, 36)).toBe('HEADER RECORD*******MEMBER HEADER RE');
                expect(rec2).toMatch(/TEST\s{4}/); // member name 'TEST'

                // Record 3: Namestr header
                const rec3 = buf.slice(160, 240).toString('ascii');
                expect(rec3.slice(0, 36)).toBe('HEADER RECORD*******NAMESTR HEADER R');
            } finally {
                cleanup(outputPath);
            }
        });

        it('round-trips numeric values through the file', async () => {
            const outputPath = tmpPath();
            try {
                const numericValues = [0, 1, -1, 3.14, -273.15, 1e10];
                const rows = numericValues.map(v => [v]);
                await exportStructuredToXpt([
                    {
                        columns: [{ name: 'VAL', type: 'DOUBLE' }],
                        rows,
                        name: 'NUMTEST',
                    },
                ], outputPath, false);

                const buf = fs.readFileSync(outputPath);
                // Find the observation data section.
                // After the observation header, each observation is 8 bytes (one numeric).
                // Find "HEADER RECORD*******OBS HEADER RECORD!!!!!!!"
                // Obs header is "HEADER RECORD*******OBS HEADER REC" (first 36 chars)
                const obsHeaderStr = 'HEADER RECORD*******OBS HEADER REC';
                const obsHeaderIdx = buf.indexOf(obsHeaderStr);
                expect(obsHeaderIdx).toBeGreaterThan(0);

                // Observation data starts after the 80-byte obs header.
                const obsStart = obsHeaderIdx + 80;

                for (let i = 0; i < numericValues.length; i++) {
                    const ibmBytes = buf.slice(obsStart + i * 8, obsStart + (i + 1) * 8);
                    const decoded = ibmDoubleToIeee(ibmBytes);
                    // For 0, the bytes are all 0 which decodes to 0
                    const expected = numericValues[i];
                    if (expected === 0) {
                        expect(decoded).toBe(0);
                    } else {
                        const rel = Math.abs((decoded - expected) / expected);
                        expect(rel).toBeLessThan(1e-10);
                    }
                }
            } finally {
                cleanup(outputPath);
            }
        });

        it('handles dropped columns in middle of column list correctly', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    {
                        columns: [
                            { name: 'ID', type: 'INTEGER' },
                            { name: 'DATA', type: 'BLOB' },
                            { name: 'NAME', type: 'VARCHAR(10)' },
                        ],
                        rows: [
                            [1, Buffer.from([0]), 'Alice'],
                            [2, Buffer.from([1]), 'Bob'],
                        ],
                        name: 'MIXED',
                    },
                ], outputPath, false);

                expect(result.success).toBe(true);
                expect(result.details?.columns).toBe(2);
                expect(result.details?.rows_exported).toBe(2);
            } finally {
                cleanup(outputPath);
            }
        });

        it('handles multiple result sets', async () => {
            const outputPath = tmpPath();
            try {
                const result = await exportStructuredToXpt([
                    {
                        columns: [{ name: 'A', type: 'INTEGER' }],
                        rows: [[1], [2]],
                        name: 'RS1',
                    },
                    {
                        columns: [{ name: 'A', type: 'INTEGER' }],
                        rows: [[3], [4]],
                        name: 'RS2',
                    },
                ], outputPath, false);

                expect(result.success).toBe(true);
                expect(result.details?.rows_exported).toBe(4);
            } finally {
                cleanup(outputPath);
            }
        });
    });
});
