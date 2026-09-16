/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiClient } from './api';
import { SharedWebWorkspace } from './sharedUiAdapter';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: new Headers(), json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

class SilentSocket {
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  public constructor(_url: string) { void _url; queueMicrotask(() => this.emit('open', {})); }
  public addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(type, callbacks);
  }
  public send(): void { return undefined; }
  public close(): void { this.emit('close', {}); }
  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const DB = { id: 'db', kind: 'database', label: 'MYDB', database: 'MYDB', hasChildren: true };
const TABLE_GROUP = { id: 'grp-table', kind: 'group', label: 'TABLE', database: 'MYDB', objectType: 'TABLE', hasChildren: true };
const EXT_GROUP = { id: 'grp-ext', kind: 'group', label: 'EXTERNAL TABLE', database: 'MYDB', objectType: 'EXTERNAL TABLE', hasChildren: true };
const EXT_OBJECT = { id: 'ext-obj', kind: 'object', label: 'EXT_USERS', database: 'MYDB', schema: 'ADMIN', objectName: 'EXT_USERS', objectType: 'EXTERNAL TABLE', hasChildren: true };
const EXT_COLUMN = { id: 'ext-col-0', kind: 'column', label: 'ID', database: 'MYDB', schema: 'ADMIN', objectName: 'EXT_USERS', columnType: 'INTEGER', hasChildren: false };

function treeFor(parentId: string | null): unknown[] {
  if (!parentId) return [DB];
  if (parentId === 'db') return [TABLE_GROUP, EXT_GROUP];
  if (parentId === 'grp-ext') return [EXT_OBJECT];
  if (parentId === 'ext-obj') return [EXT_COLUMN];
  if (parentId === 'grp-table') return [];
  return [];
}

describe('external table explorer support in shared Web mode', () => {
  it('expands the EXTERNAL TABLE group and object without touching TABLE, then requests EXTERNAL DDL', async () => {
    const user = userEvent.setup();
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/connections')) {
        return response([{ id: 'connection-1', name: 'Netezza', host: 'h', port: 5480, database: 'MYDB', user: 'u', dbType: 'netezza', readOnly: true }]);
      }
      if (url.includes('/api/schema/tree')) {
        const parentId = new URL(url, 'http://localhost').searchParams.get('parentId');
        return response({ nodes: treeFor(parentId) });
      }
      if (url.includes('/api/metadata/ddl')) {
        return response({ success: true, ddlCode: 'CREATE EXTERNAL TABLE MYDB.ADMIN.EXT_USERS (ID INTEGER);', ddlFidelity: 'exact' });
      }
      if (url.endsWith('/api/history')) return response([]);
      return response({ ok: true });
    });
    const api = createApiClient({ fetch: fetchMock, WebSocket: SilentSocket as unknown as new (url: string) => WebSocket });
    render(<SharedWebWorkspace api={api} user={{ id: 'external-table-user', username: 'alice', role: 'user' }} onLogout={() => undefined} />);

    await user.click(await screen.findByRole('button', { name: 'Expand MYDB' }));
    await user.click(await screen.findByRole('button', { name: 'Expand EXTERNAL TABLE' }));
    await user.click(await screen.findByRole('button', { name: 'Expand EXT_USERS' }));
    await screen.findByRole('treeitem', { name: /ID/ });

    const treeParents = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.includes('/api/schema/tree'))
      .map(url => new URL(url, 'http://localhost').searchParams.get('parentId'));
    expect(treeParents).toContain('grp-ext');
    expect(treeParents).toContain('ext-obj');

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: /EXT_USERS/ }), { clientX: 32, clientY: 48 });
    await user.click(await screen.findByRole('menuitem', { name: 'Create DDL Code' }));
    await waitFor(() => {
      const ddlCall = fetchMock.mock.calls
        .map(([input]) => String(input))
        .find(url => url.includes('/api/metadata/ddl'));
      expect(ddlCall).toBeDefined();
      const query = new URL(ddlCall ?? '', 'http://localhost').searchParams;
      expect(query.get('objectType')).toBe('EXTERNAL TABLE');
      expect(query.get('objectName')).toBe('EXT_USERS');
    });
    await screen.findByDisplayValue(/CREATE EXTERNAL TABLE MYDB\.ADMIN\.EXT_USERS/);
  });
});
