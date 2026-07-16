import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuerySessionManager } from '../src/querySessions';
import { createQueryExportStream } from '../src/queryExport';

describe('QuerySessionManager', () => {
  it('stores rows on disk and pages with filtering and sorting', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-query-session-'));
    const manager = new QuerySessionManager(dataDir);
    try {
      const sessionId = manager.create('query-1', 'user-1', 'connection-1', [{ name: 'ID', type: 'INT' }, { name: 'NAME', type: 'VARCHAR' }]);
      manager.appendRows('user-1', sessionId, [[1, 'alpha'], [3, 'gamma'], [2, 'beta']]);
      expect(manager.complete('user-1', sessionId)).toBe(3);
      const page = manager.page('user-1', sessionId, { sorting: [{ columnIndex: 0, desc: true }], globalFilter: 'a', offset: 0, limit: 2 });
      expect(page.rows).toEqual([[3, 'gamma'], [2, 'beta']]);
      expect(page.totalRows).toBe(3);
      expect(page.hasMore).toBe(true);
      const exported = createQueryExportStream(manager, 'user-1', sessionId, { format: 'csv', sorting: [{ columnIndex: 0, desc: true }] });
      const chunks: Buffer[] = [];
      for await (const chunk of exported.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      expect(Buffer.concat(chunks).toString()).toBe('ID,NAME\n3,gamma\n2,beta\n1,alpha\n');
    } finally {
      manager.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves duplicate column labels in JSON exports', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-query-session-'));
    const manager = new QuerySessionManager(dataDir);
    try {
      const sessionId = manager.create('query-2', 'user-1', 'connection-1', [{ name: 'ID', type: 'INT' }, { name: 'ID', type: 'INT' }, { name: 'ID_2', type: 'INT' }]);
      manager.appendRows('user-1', sessionId, [[1, 2, 3]]);
      manager.complete('user-1', sessionId);
      const exported = createQueryExportStream(manager, 'user-1', sessionId, { format: 'json' });
      const chunks: Buffer[] = [];
      for await (const chunk of exported.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([{ ID: 1, ID_2: 2, ID_2_2: 3 }]);
    } finally {
      manager.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
