import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTabularDataImporter, TabularDataImporter } from '../../packages/tabular-import-runtime/src/index';

interface TestXlsxWriter {
  startSheet(sheetName: string, columnCount: number, headers?: string[]): void;
  writeRow(row: unknown[]): void;
  endSheet(): void;
  finalize(): Promise<void>;
}

const XlsxWriter = require('@justybase/spreadsheet-tasks').XlsxWriter as new (filePath: string) => TestXlsxWriter;

describe('tabular-import-runtime regressions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabular-import-runtime-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads the complete first CSV record when delimiter detection crosses a chunk boundary', () => {
    const filePath = path.join(tempDir, 'wide-header.csv');
    fs.writeFileSync(filePath, `${'A'.repeat(70 * 1024)};B\nvalue;other\n`, 'utf8');

    const importer = createTabularDataImporter(filePath);

    expect(importer.getCsvDelimiter()).toBe(';');
  });

  it('keeps the legacy target-table constructor call compatible with runtime options', async () => {
    const filePath = path.join(tempDir, 'legacy-constructor.csv');
    fs.writeFileSync(filePath, 'Active\ntrue\n', 'utf8');

    const importer = createTabularDataImporter(filePath, 'TARGET_TABLE', { inferBoolean: true });
    await importer.analyzeDataTypes();

    expect(importer.getEffectiveColumnDescriptors()[0]?.dataType).toBe('BOOLEAN');
  });

  it('does not discard the first headerless workbook row when sampling before analysis', async () => {
    const filePath = path.join(tempDir, 'headerless-sample.xlsx');
    const writer = new XlsxWriter(filePath);
    writer.startSheet('Sheet1', 2);
    writer.writeRow([1, 'first']);
    writer.writeRow([2, 'second']);
    writer.endSheet();
    await writer.finalize();

    const importer = createTabularDataImporter(filePath);

    await expect(importer.getSampleRows(2)).resolves.toEqual([
      ['1', 'first'],
      ['2', 'second'],
    ]);
  });

  it('uses fieldCount/getValue when the reader exposes an empty current-row buffer', () => {
    const importer = Object.create(TabularDataImporter.prototype) as TabularDataImporter;
    const getCurrentExcelRow = (importer as unknown as { getCurrentExcelRow(reader: unknown): unknown[] }).getCurrentExcelRow;
    expect(getCurrentExcelRow.call(importer, {
      _currentRow: [],
      fieldCount: 2,
      getValue: (index: number) => index === 0 ? 'A' : 'B',
    })).toEqual(['A', 'B']);
  });

  it('keeps columns introduced by later rows in a headerless workbook', async () => {
    const filePath = path.join(tempDir, 'wider-later-row.xlsx');
    const writer = new XlsxWriter(filePath);
    writer.startSheet('Sheet1', 3);
    writer.writeRow([1, 'first', undefined]);
    writer.writeRow([2, 'second', undefined]);
    writer.writeRow([3, 'third', 'later column']);
    writer.endSheet();
    await writer.finalize();

    const importer = createTabularDataImporter(filePath);
    await importer.analyzeDataTypes();

    expect(importer.getSourceHeaders()).toEqual(['COL_1', 'COL_2', 'COL_3']);
    expect(importer.getEffectiveColumnDescriptors()).toHaveLength(3);
    await expect(importer.getAllRows()).resolves.toEqual([
      ['1', 'first'],
      ['2', 'second'],
      ['3', 'third', 'later column'],
    ]);
  });
});
