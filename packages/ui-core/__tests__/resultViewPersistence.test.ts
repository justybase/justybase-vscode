import {
  decodeLegacyResultView,
  decodePersistedResultView,
  encodePersistedResultView,
  normalizeResultView,
  resultViewPersistenceIdentity,
  resultViewPersistenceKey,
} from '../src';
import type { UiResultViewState } from '../src';

const identity = {
  productId: 'web',
  userId: 'alice',
  workspaceId: 'web:alice',
  sourceId: 'web:alice',
} as const;

const view: UiResultViewState = {
  globalFilter: 'orders',
  columnFilters: { STATUS: 'open' },
  sorting: [{ column: 'CREATED_AT', descending: true }],
  grouping: ['STATUS'],
  aggregation: 'count',
  pivotColumn: 'STATUS',
  columnVisibility: { INTERNAL: false },
  columnOrder: ['ID', 'STATUS'],
  pinnedColumns: ['ID'],
  columnWidths: { ID: 120, STATUS: 240 },
  scrollTop: 9_000,
  scrollLeft: 320,
  anchorRow: 300,
};

describe('result view persistence', () => {
  it('round-trips the complete portable view with result identity', () => {
    const resultIdentity = resultViewPersistenceIdentity(identity, 'result-1');
    const encoded = encodePersistedResultView(view, { scope: 'user', identity: resultIdentity });
    expect(decodePersistedResultView(encoded, { scope: 'user', identity: resultIdentity })).toEqual(view);
    expect(resultViewPersistenceKey('source/result 1')).toBe('result_view_v1_source%2Fresult%201');
    expect(JSON.parse(encoded)).not.toHaveProperty('payload.rows');
  });

  it('rejects foreign scope/identity and malformed persisted values without throwing', () => {
    const resultIdentity = resultViewPersistenceIdentity(identity, 'result-1');
    const encoded = encodePersistedResultView(view, { scope: 'user', identity: resultIdentity });
    expect(decodePersistedResultView(encoded, { scope: 'profile', identity: resultIdentity })).toBeUndefined();
    expect(decodePersistedResultView(encoded, { scope: 'user', identity: { ...resultIdentity, userId: 'bob' } })).toBeUndefined();
    expect(decodePersistedResultView('{"schemaVersion":1}', { scope: 'user', identity: resultIdentity })).toBeUndefined();
    expect(decodePersistedResultView(JSON.stringify({ schemaVersion: 1, scope: 'user', identity: resultIdentity, payload: { view: { scrollTop: null } } }), { scope: 'user', identity: resultIdentity })).toBeUndefined();
  });

  it('normalises safe bounds and maps the legacy TanStack grid envelope', () => {
    expect(normalizeResultView({ scrollTop: -1, scrollLeft: 12.5, anchorRow: 4, columnWidths: { ID: 99999 } })).toMatchObject({ scrollTop: 0, scrollLeft: 12.5, anchorRow: 4, columnWidths: { ID: 4096 } });
    expect(normalizeResultView({ columnFilters: { ID: '1' }, sorting: [{ column: 'ID', descending: false }], grouping: [] })).toMatchObject({ columnFilters: { ID: '1' }, sorting: [{ column: 'ID', descending: false }] });
    expect(decodeLegacyResultView(JSON.stringify({ version: 2, resultSetId: 'result-1', state: {
      globalFilter: 'open',
      columnFilters: [{ id: '1', value: 'x' }],
      sorting: [{ id: '0', desc: true }],
      grouping: ['1'],
      columnVisibility: { '2': false },
      columnOrder: ['0', '1'],
      columnPinning: { left: ['0'], right: ['1'] },
      columnWidths: { '0': 140 },
      scrollTop: 6_000,
      scrollLeft: 128,
      scrollAnchorRow: 200,
    } }), 'result-1')).toEqual({
      globalFilter: 'open',
      columnFilters: { '1': 'x' },
      sorting: [{ column: '0', descending: true }],
      grouping: ['1'],
      columnVisibility: { '2': false },
      columnOrder: ['0', '1'],
      pinnedColumns: ['0', '1'],
      columnWidths: { '0': 140 },
      scrollTop: 6_000,
      scrollLeft: 128,
      anchorRow: 200,
    });
  });
});
