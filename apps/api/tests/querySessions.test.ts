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

  it('calculates aggregates over the complete spool and the filtered view', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-query-session-'));
    const manager = new QuerySessionManager(dataDir);
    try {
      const sessionId = manager.create('query-aggregate', 'user-1', 'connection-1', [{ name: 'AMOUNT', type: 'INT' }, { name: 'CATEGORY', type: 'VARCHAR' }], 2, 3);
      manager.appendRows('user-1', sessionId, [[10, 'alpha'], [20, 'beta'], [30, 'alpha'], [null, 'alpha']]);
      manager.complete('user-1', sessionId, { rowsAffected: 4, limitReached: false, message: 'SELECT complete.' });

      const all = manager.aggregate('user-1', sessionId, { columnIndices: [0] });
      expect(all.statementIndex).toBe(2);
      expect(all.filteredRowCount).toBe(4);
      expect(all.values[0]).toEqual(expect.objectContaining({ columnIndex: 0, count: 3, sum: 60, avg: 20, min: 10, max: 30 }));

      const filtered = manager.aggregate('user-1', sessionId, { globalFilter: 'alpha', columnIndices: [0] });
      expect(filtered.filteredRowCount).toBe(3);
      expect(filtered.values[0]).toEqual(expect.objectContaining({ count: 2, sum: 40, avg: 20, min: 10, max: 30 }));

      const page = manager.page('user-1', sessionId, {});
      expect(page.rowsAffected).toBe(4);
      expect(page.message).toBe('SELECT complete.');
    } finally {
      manager.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('sorts and aggregates high-precision numeric text without REAL rounding', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-query-session-'));
    const manager = new QuerySessionManager(dataDir);
    try {
      const sessionId = manager.create('query-precision', 'user-1', 'connection-1', [{ name: 'AMOUNT', type: 'DECIMAL(30, 0)' }]);
      manager.appendRows('user-1', sessionId, [['9007199254740993'], ['9007199254740992'], ['1']]);
      manager.complete('user-1', sessionId);
      expect(manager.page('user-1', sessionId, { sorting: [{ columnIndex: 0, desc: false }] }).rows).toEqual([['1'], ['9007199254740992'], ['9007199254740993']]);
      expect(manager.aggregate('user-1', sessionId, { columnIndices: [0], functions: ['count', 'sum', 'avg', 'min', 'max'] }).values[0]).toEqual({
        columnIndex: 0,
        count: 3,
        sum: '18014398509481986',
        avg: '6004799503160662',
        min: '1',
        max: '9007199254740993',
      });
    } finally {
      manager.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces session ownership and expiration', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-query-session-'));
    const manager = new QuerySessionManager(dataDir, 1_000);
    try {
      const sessionId = manager.create('query-expiry', 'user-1', 'connection-1', [{ name: 'ID', type: 'INT' }]);
      manager.appendRows('user-1', sessionId, [[1]]);
      expect(() => manager.page('user-2', sessionId, {})).toThrow('unavailable');
      const expiresAt = manager.manifest('user-1', sessionId).expiresAt;
      manager.cleanup(expiresAt + 1);
      expect(manager.querySessionId('user-1', 'query-expiry')).toBeUndefined();
    } finally {
      manager.closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
