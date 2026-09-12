import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { XlsbWriter, XlsxWriter } from '@justybase/spreadsheet-tasks';
import type { QueryColumn, QueryFileImportPreviewRequest } from '@justybase/contracts';
import { createQueryExportStream } from '../src/queryExport';
import { materializeFileImport } from '../src/queryWriteSupport';
import { QuerySessionManager } from '../src/querySessions';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function fileImport(content: string | Buffer, fileName = 'import.csv', overrides: Partial<QueryFileImportPreviewRequest> = {}): QueryFileImportPreviewRequest {
  return {
    connectionId: 'connection-1',
    database: 'DB1',
    schema: 'PUBLIC',
    table: 'ORDERS',
    fileName,
    contentBase64: Buffer.from(content).toString('base64'),
    format: 'csv',
    hasHeader: true,
    delimiter: ',',
    ...overrides,
  };
}

async function createSession(columns: QueryColumn[], rows: unknown[][]): Promise<{ dataDir: string; manager: QuerySessionManager; sessionId: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-query-movement-'));
  const manager = new QuerySessionManager(dataDir);
  const sessionId = manager.create('query-movement', 'user-1', 'connection-1', columns);
  manager.appendRows('user-1', sessionId, rows);
  manager.complete('user-1', sessionId);
  return { dataDir, manager, sessionId };
}

async function writeWorkbook(kind: 'xlsx' | 'xlsb'): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'justybase-spreadsheet-movement-'));
  const filePath = path.join(directory, `source.${kind}`);
  try {
    const Writer = kind === 'xlsx' ? XlsxWriter : XlsbWriter;
    const writer = new Writer(filePath);
    const headers = ['ID', 'AMOUNT', 'EVENT_AT', 'LABEL'];
    writer.startSheet('Import', headers.length, headers, { doAutofilter: true });
    writer.writeRow([
      9223372036854775807n,
      '12345678901234567890.123400',
      new Date('2026-09-12T10:34:56.789Z'),
      'Zażółć gęślą jaźń',
    ]);
    writer.endSheet();
    await writer.finalize();
    return await readFile(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('API data movement contracts', () => {
  it('round-trips NULL, Unicode, large integer, decimal text, timestamp text, and CSV quoting', async () => {
    const columns: QueryColumn[] = [
      { name: 'ID', type: 'BIGINT' },
      { name: 'AMOUNT', type: 'DECIMAL(30,6)' },
      { name: 'EVENT_AT', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'LABEL', type: 'VARCHAR' },
      { name: 'OPTIONAL_VALUE', type: 'VARCHAR' },
    ];
    const rows = [[
      '9223372036854775807',
      '12345678901234567890.123400',
      '2026-09-12T10:34:56.789+02:00',
      'Zażółć, "gęślą"\n第二行',
      null,
    ]];
    const fixture = await createSession(columns, rows);
    try {
      const csv = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'csv' }).stream);
      const materialized = await materializeFileImport(fileImport(csv));
      expect(materialized.columns).toEqual(['ID', 'AMOUNT', 'EVENT_AT', 'LABEL', 'OPTIONAL_VALUE']);
      expect(materialized.rows).toEqual(rows.map(row => [...row]));
      expect(csv.toString()).toContain('"Zażółć, ""gęślą""\n第二行"');
    } finally {
      fixture.manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('keeps compressed CSV byte-equivalent to the uncompressed export', async () => {
    const fixture = await createSession(
      [{ name: 'ID', type: 'BIGINT' }, { name: 'VALUE', type: 'VARCHAR' }],
      [['9223372036854775807', 'alpha'], [null, 'βeta']],
    );
    try {
      const csv = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'csv' }).stream);
      const gzip = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'csv.gz' }).stream);
      expect(gunzipSync(gzip)).toEqual(csv);

      const zstd = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'csv.zst' }).stream);
      expect(zstdDecompressSync(zstd)).toEqual(csv);
    } finally {
      fixture.manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('stops a disk-backed export when the consumer cancels after the first chunk', async () => {
    const fixture = await createSession(
      [{ name: 'ID', type: 'INTEGER' }, { name: 'VALUE', type: 'VARCHAR' }],
      Array.from({ length: 10_000 }, (_unused, index) => [index, `value-${index}`]),
    );
    const exported = createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'csv' });
    try {
      const firstChunk = new Promise<void>((resolve, reject) => {
        exported.stream.once('error', reject);
        exported.stream.once('data', () => {
          exported.stream.pause();
          resolve();
        });
      });
      await firstChunk;
      const closed = new Promise<void>((resolve, reject) => {
        exported.stream.once('error', reject);
        exported.stream.once('close', () => resolve());
      });
      exported.stream.destroy();
      await closed;
      expect(exported.stream.destroyed).toBe(true);
    } finally {
      exported.stream.destroy();
      fixture.manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('preserves duplicate JSON labels, SQL NULL, XML escaping, and Markdown NULL markers', async () => {
    const fixture = await createSession(
      [{ name: 'ID', type: 'BIGINT' }, { name: 'ID', type: 'BIGINT' }, { name: 'NOTE', type: 'VARCHAR' }],
      [['9223372036854775807', null, 'A < B | C']],
    );
    try {
      const json = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'json' }).stream);
      expect(JSON.parse(json.toString())).toEqual([{ ID: '9223372036854775807', ID_2: null, NOTE: 'A < B | C' }]);

      const sql = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'sql' }).stream);
      expect(sql.toString()).toContain("VALUES ('9223372036854775807', NULL, 'A < B | C');");

      const xml = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'xml' }).stream);
      expect(xml.toString()).toContain('<NOTE>A &lt; B | C</NOTE>');

      const markdown = await collect(createQueryExportStream(fixture.manager, 'user-1', fixture.sessionId, { format: 'markdown' }).stream);
      expect(markdown.toString()).toContain('| 9223372036854775807 | NULL | A < B \\| C |');
    } finally {
      fixture.manager.closeAll();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('deduplicates headers and maps headerless empty fields to NULL using target columns', async () => {
    const duplicate = await materializeFileImport(fileImport('ID,id,\n1,2,3\n'));
    expect(duplicate.columns).toEqual(['ID', 'id_2', 'column_3']);
    expect(duplicate.rows).toEqual([['1', '2', '3']]);

    const headerless = await materializeFileImport(fileImport('1,,3\n', 'headerless.csv', { hasHeader: false }), ['FIRST', 'SECOND', 'THIRD']);
    expect(headerless.columns).toEqual(['FIRST', 'SECOND', 'THIRD']);
    expect(headerless.rows).toEqual([['1', null, '3']]);
  });

  it.each(['xlsx', 'xlsb'] as const)('imports %s through the public spreadsheet reader surface', async format => {
    const materialized = await materializeFileImport(fileImport(await writeWorkbook(format), `source.${format}`, { format }));
    expect(materialized.columns).toEqual(['ID', 'AMOUNT', 'EVENT_AT', 'LABEL']);
    expect(materialized.rows).toHaveLength(1);
    expect(materialized.rows[0]?.[0]).toBe('9223372036854775807');
    expect(materialized.rows[0]?.[1]).toBe('12345678901234567890.123400');
    expect(materialized.rows[0]?.[2]).toEqual(new Date('2026-09-12T10:34:56.789Z'));
    expect(materialized.rows[0]?.[3]).toBe('Zażółć gęślą jaźń');
  });

  it('rejects empty, header-only, malformed, and over-sized row inputs and removes temp files on failure', async () => {
    await expect(materializeFileImport(fileImport('', 'empty.csv'))).rejects.toThrow('empty');
    await expect(materializeFileImport(fileImport('ID,VALUE\n', 'header-only.csv'))).rejects.toThrow('header but no data');
    const before = new Set((await readdir(os.tmpdir())).filter(name => name.startsWith('justybase-web-import-')));
    await expect(materializeFileImport(fileImport('ID,VALUE\n"unterminated,1\n', 'malformed.csv'))).rejects.toThrow('unterminated');
    const after = new Set((await readdir(os.tmpdir())).filter(name => name.startsWith('justybase-web-import-')));
    expect([...after].filter(name => !before.has(name))).toEqual([]);

    const rows = Array.from({ length: 10_001 }, () => '1');
    await expect(materializeFileImport(fileImport(`ID\n${rows.join('\n')}\n`, 'too-many.csv'))).rejects.toThrow('10,000');
  });
});
