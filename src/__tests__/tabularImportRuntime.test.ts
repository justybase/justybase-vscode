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

const spreadsheetTasks = require('@justybase/spreadsheet-tasks') as {
  XlsxWriter: new (filePath: string) => TestXlsxWriter;
  XlsbWriter: new (filePath: string) => TestXlsxWriter;
};
const XlsxWriter = spreadsheetTasks.XlsxWriter;

async function writeTwoSheetWorkbook(
  filePath: string,
  createWriter: (filePath: string) => TestXlsxWriter,
): Promise<void> {
  const writer = createWriter(filePath);
  writer.startSheet('First', 2, ['ID', 'NAME']);
  writer.writeRow([1, 'Alice']);
  writer.endSheet();
  writer.startSheet('Second', 2, ['CODE', 'VALUE']);
  writer.writeRow([9, 'Zulu']);
  writer.writeRow([10, 'Yankee']);
  writer.endSheet();
  await writer.finalize();
}

const SHEET_FORMATS: Array<{
  format: 'xlsx' | 'xlsb';
  extension: string;
  createWriter: (filePath: string) => TestXlsxWriter;
}> = [
  {
    format: 'xlsx',
    extension: '.xlsx',
    createWriter: (filePath) => new spreadsheetTasks.XlsxWriter(filePath),
  },
  {
    format: 'xlsb',
    extension: '.xlsb',
    createWriter: (filePath) => new spreadsheetTasks.XlsbWriter(filePath),
  },
];

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

  it('parses quoted fields with embedded newlines like the desktop importer', async () => {
    const filePath = path.join(tempDir, 'quoted-newlines.csv');
    fs.writeFileSync(filePath, 'id,note\n1,"first\nsecond"\n2,"has,comma"\n', 'utf8');

    const importer = createTabularDataImporter(filePath);
    await importer.analyzeDataTypes();
    const rows = await importer.getAllRows();

    expect(rows).toEqual([
      ['1', 'first\nsecond'],
      ['2', 'has,comma'],
    ]);
  });

  it('honors hasHeaders=false when reading delimited rows', async () => {
    const filePath = path.join(tempDir, 'headerless.csv');
    fs.writeFileSync(filePath, '1,Alice\n2,Bob\n', 'utf8');

    const importer = createTabularDataImporter(filePath, { hasHeaders: false });
    await importer.analyzeDataTypes();
    const rows = await importer.getAllRows();

    expect(rows).toHaveLength(2);
    expect(importer.getSourceHeaders()).toEqual(['COL_1', 'COL_2']);
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

  it.each(SHEET_FORMATS)(
    'reads the selected non-first worksheet from $format workbooks',
    async ({ extension, createWriter }) => {
      const filePath = path.join(tempDir, `two-sheets${extension}`);
      await writeTwoSheetWorkbook(filePath, createWriter);

      const importer = createTabularDataImporter(filePath);
      await expect(importer.getAvailableSheetNames()).resolves.toEqual(['First', 'Second']);

      importer.setSelectedSheet('Second');
      await importer.analyzeDataTypes();

      expect(importer.getSourceHeaders()).toEqual(['CODE', 'VALUE']);
      await expect(importer.getAllRows()).resolves.toEqual([
        ['9', 'Zulu'],
        ['10', 'Yankee'],
      ]);
    },
  );

  it.each(SHEET_FORMATS)(
    'fails with the available worksheet list for unknown $format sheets',
    async ({ extension, createWriter }) => {
      const filePath = path.join(tempDir, `two-sheets${extension}`);
      await writeTwoSheetWorkbook(filePath, createWriter);

      const importer = createTabularDataImporter(filePath);
      importer.setSelectedSheet('Missing');

      await expect(importer.analyzeDataTypes()).rejects.toThrow(
        /Worksheet "Missing" was not found.*Available worksheets: First, Second\./,
      );
    },
  );

  it('detects comma decimals when the sample also contains dotted dates', async () => {
    const filePath = path.join(tempDir, 'pl-dates.csv');
    fs.writeFileSync(
      filePath,
      'DATA;KWOTA\n07.06.2024;1 234,56\n08.06.2024;2 345,67\n',
      'utf8',
    );

    const importer = createTabularDataImporter(filePath);
    await importer.analyzeDataTypes();

    expect(importer.getDecimalDelimiter()).toBe(',');
    const kwota = importer.getEffectiveColumnDescriptors()[1];
    expect(kwota?.dataType).toMatch(/^NUMERIC/);
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
