import path from 'node:path';
import { HARD_SQL_FILE_MAX_BYTES } from '@justybase/contracts';
import { createSqlFileService } from '../src/main/sqlFileService';
import type { SqlFileServiceOptions } from '../src/main/sqlFileService';

function fixtureService(overrides: Partial<{
  openSelection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
  saveSelection: { readonly canceled: boolean; readonly filePath?: string };
  files: Map<string, string>;
  sizes: Map<string, number>;
}> = {}): { service: ReturnType<typeof createSqlFileService>; files: Map<string, string> } {
  const files = overrides.files ?? new Map<string, string>([[path.normalize('/tmp/report.sql'), 'SELECT 1;']]);
  const sizes = overrides.sizes ?? new Map<string, number>();
  const options: SqlFileServiceOptions = {
    dialog: {
      showOpenDialog: async () => overrides.openSelection ?? { canceled: false, filePaths: [path.normalize('/tmp/report.sql')] },
      showSaveDialog: async () => overrides.saveSelection ?? { canceled: false, filePath: path.normalize('/tmp/report.sql') },
    },
    owner: () => undefined,
    fs: {
      readFile: async filePath => {
        const content = files.get(path.normalize(filePath));
        if (content === undefined) throw new Error('ENOENT');
        return content;
      },
      writeFile: async (filePath, content) => {
        files.set(path.normalize(filePath), content);
      },
      statSize: async filePath => {
        const normalized = path.normalize(filePath);
        const override = sizes.get(normalized);
        if (override !== undefined) return override;
        const content = files.get(normalized);
        if (content === undefined) throw new Error('ENOENT');
        return Buffer.byteLength(content, 'utf8');
      },
      byteLength: content => Buffer.byteLength(content, 'utf8'),
    },
  };
  return { service: createSqlFileService(options), files };
}

describe('Electron SQL file service', () => {
  it('opens a .sql file through the dialog and grants its path', async () => {
    const { service } = fixtureService();
    const file = await service.openSqlFile();
    expect(file).toMatchObject({ filePath: path.normalize('/tmp/report.sql'), fileName: 'report.sql', content: 'SELECT 1;', oversize: false });

    const saved = await service.saveSqlFile(path.normalize('/tmp/report.sql'), 'SELECT 2;');
    expect(saved).toMatchObject({ filePath: path.normalize('/tmp/report.sql'), fileName: 'report.sql' });
  });

  it('returns null when the open dialog is cancelled', async () => {
    const { service } = fixtureService({ openSelection: { canceled: true, filePaths: [] } });
    await expect(service.openSqlFile()).resolves.toBeNull();
  });

  it('rejects non-sql extensions and relative paths', async () => {
    const { service } = fixtureService({ openSelection: { canceled: false, filePaths: [path.normalize('/tmp/notes.txt')] } });
    await expect(service.openSqlFile()).rejects.toThrow('Only .sql files are supported.');

    const { service: relative } = fixtureService({ openSelection: { canceled: false, filePaths: ['relative/report.sql'] } });
    await expect(relative.openSqlFile()).rejects.toThrow('absolute');
  });

  it('flags files above the 2 MB soft threshold but still opens them', async () => {
    const big = 'SELECT 1;'.padEnd(2 * 1024 * 1024 + 8, ' ');
    const { service } = fixtureService({
      files: new Map([[path.normalize('/tmp/big.sql'), big]]),
      openSelection: { canceled: false, filePaths: [path.normalize('/tmp/big.sql')] },
    });
    const file = await service.openSqlFile();
    expect(file?.oversize).toBe(true);
    expect(file?.content).toBe(big);
  });

  it('rejects files above the 25 MB hard cap', async () => {
    const { service } = fixtureService({
      sizes: new Map([[path.normalize('/tmp/huge.sql'), HARD_SQL_FILE_MAX_BYTES + 1]]),
      openSelection: { canceled: false, filePaths: [path.normalize('/tmp/huge.sql')] },
    });
    await expect(service.openSqlFile()).rejects.toThrow('too large');
  });

  it('requires a dialog grant before overwriting and supports Save As', async () => {
    const { service, files } = fixtureService();
    await expect(service.saveSqlFile(path.normalize('/tmp/other.sql'), 'SELECT 9;')).rejects.toThrow('Save As');

    const saved = await service.saveSqlFileAs('other.sql', 'SELECT 9;');
    expect(saved?.filePath).toBe(path.normalize('/tmp/report.sql'));
    expect(files.get(path.normalize('/tmp/report.sql'))).toBe('SELECT 9;');
  });

  it('returns null when Save As is cancelled and appends .sql when missing', async () => {
    const { service } = fixtureService({ saveSelection: { canceled: true } });
    await expect(service.saveSqlFileAs('query.sql', 'SELECT 1;')).resolves.toBeNull();

    const appending = fixtureService({ saveSelection: { canceled: false, filePath: path.normalize('/tmp/export') } });
    const saved = await appending.service.saveSqlFileAs('export', 'SELECT 1;');
    expect(saved?.filePath).toBe(path.normalize('/tmp/export.sql'));
  });
});
