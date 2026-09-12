import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DataGrid, processDataGridRows } from '../packages/ui-react/src/dataGrid';
import type { DataGridColumn, DataGridViewState, GridScrollPosition } from '../packages/ui-react/src/dataGrid';
import '../packages/ui-react/src/resultGrid.css';

type HarnessRow = readonly unknown[];

interface SharedGridMeasurement {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly firstRowId: number | null;
  readonly firstVisibleText: string;
  readonly renderedRowCount: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly anchorRow: number;
}

interface SharedGridHarnessApi {
  readonly profile: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: readonly HarnessRow[];
  readonly measureFilter: (query: string) => Promise<SharedGridMeasurement>;
  readonly measureSort: (descending: boolean) => Promise<SharedGridMeasurement>;
  readonly measureScroll: (top: number, left: number) => Promise<SharedGridMeasurement>;
  readonly snapshot: () => SharedGridMeasurement;
}

declare global {
  interface Window {
    __sharedDataGrid: SharedGridHarnessApi;
  }
}

const profile = new URLSearchParams(window.location.search).get('profile') ?? 'comparison';
const profileDefinition = profile === 'filter-4000x32'
  ? { rowCount: 4_000, columnCount: 32 }
  : { rowCount: 10_000, columnCount: 16 };

const columnNames = ['ID', 'AMOUNT', 'NAME', 'EVENT_DATE', 'EVENT_AT', 'ACTIVE', 'CATEGORY', 'PAYLOAD', 'RANKING', 'SEARCH_LABEL', 'REFERENCE', 'QUANTITY', 'OPTIONAL_TEXT', 'RATIO', 'GROUP_KEY', 'DETAILS'];
const columnTypes = ['INTEGER', 'NUMERIC(18,2)', 'VARCHAR(160)', 'DATE', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR(32)', 'VARCHAR(256)', 'INTEGER', 'VARCHAR(64)', 'VARCHAR(48)', 'INTEGER', 'VARCHAR(180)', 'DOUBLE', 'VARCHAR(32)', 'VARCHAR(512)'];

const columns: readonly DataGridColumn[] = Array.from({ length: profileDefinition.columnCount }, (_value, index) => ({
  name: columnNames[index] ?? `EXTRA_${String(index + 1).padStart(2, '0')}`,
  type: columnTypes[index] ?? (index % 3 === 0 ? 'INTEGER' : 'VARCHAR(96)'),
}));

function deterministicValue(index: number, salt: number): number {
  let value = (0x5eed_2026 ^ Math.imul(index + 1, 0x45d9f3b) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value ^ (value >>> 13)) >>> 0;
}

function buildRow(index: number): HarnessRow {
  const middle = Math.floor(profileDefinition.rowCount / 2);
  const row: unknown[] = [
    index + 1,
    Number((((deterministicValue(index, 1) % 100_000) / 100) - 250).toFixed(2)),
    index === 0 ? 'needle-start customer-000000' : index === middle ? 'needle-middle customer-005000' : `customer-${String(index).padStart(6, '0')}`,
    `2024-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
    `2024-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:30`,
    index % 3 !== 0,
    ['engineering', 'finance', 'operations', 'sales', 'support'][index % 5],
    `payload-${String(index).padStart(6, '0')}-${'x'.repeat(32 + (index % 32))}`,
    (deterministicValue(index, 2) % 100) + 1,
    index === 0 ? 'search-start' : index === middle ? 'search-middle' : `label-${index % 23}`,
    `ref-${(deterministicValue(index, 3) % 1_000_000).toString(16).padStart(6, '0')}`,
    deterministicValue(index, 4) % 500,
    index % 11 === 0 ? null : `optional-${index % 19}`,
    Number(((deterministicValue(index, 5) % 10_000) / 997).toFixed(4)),
    `group-${index % 17}`,
    `details-${String(index).padStart(6, '0')}-${'d'.repeat(48 + (index % 64))}`,
  ];
  while (row.length < profileDefinition.columnCount) {
    const columnIndex = row.length;
    row.push(columnIndex % 3 === 0 ? deterministicValue(index, columnIndex) % 10_000 : `extra-${columnIndex}-${index % 37}`);
  }
  return row.slice(0, profileDefinition.columnCount);
}

const rows = Array.from({ length: profileDefinition.rowCount }, (_value, index) => buildRow(index));
const initialScroll: GridScrollPosition = {
  resultSetId: `shared-harness:${profile}`,
  top: Number(sessionStorage.getItem(`shared-grid-scroll:${profile}:top`) ?? 0),
  left: Number(sessionStorage.getItem(`shared-grid-scroll:${profile}:left`) ?? 0),
  anchorRow: Number(sessionStorage.getItem(`shared-grid-scroll:${profile}:anchor`) ?? 0),
};

function expectedRowCount(view: DataGridViewState): number {
  return processDataGridRows(columns, rows, view).length;
}

function firstVisibleText(): string {
  return document.querySelector('.ui-data-grid-scroll tbody tr:not(.ui-data-grid-virtual-spacer)')?.textContent?.trim() ?? '';
}

function firstRowId(): number | null {
  const text = document.querySelector('.ui-data-grid-scroll tbody tr:not(.ui-data-grid-virtual-spacer) td')?.textContent ?? '';
  const normalized = text.replace(/[\s,\u00a0]/gu, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function renderedRowCount(): number {
  return document.querySelectorAll('.ui-data-grid-scroll tbody tr:not(.ui-data-grid-virtual-spacer)').length;
}

function currentVisibleCount(fallback: number): number {
  const value = Number(document.getElementById('shared-visible-count')?.textContent ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function currentAnchor(fallback: number): number {
  const value = Number(document.getElementById('shared-anchor')?.textContent ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function waitForFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function App(): ReactElement {
  const resultSetId = `shared-harness:${profile}`;
  const [view, setView] = useState<DataGridViewState>({ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] });
  const [scroll, setScroll] = useState<GridScrollPosition>(initialScroll);
  const [ready, setReady] = useState(false);
  const visibleCount = useMemo(() => expectedRowCount(view), [view]);

  const onScroll = useCallback((position: GridScrollPosition): void => {
    setScroll(position);
    sessionStorage.setItem(`shared-grid-scroll:${profile}:top`, String(position.top));
    sessionStorage.setItem(`shared-grid-scroll:${profile}:left`, String(position.left));
    sessionStorage.setItem(`shared-grid-scroll:${profile}:anchor`, String(position.anchorRow ?? 0));
  }, []);

  const snapshot = useCallback((): SharedGridMeasurement => ({
    durationMs: 0,
    rowCount: currentVisibleCount(visibleCount),
    firstRowId: firstRowId(),
    firstVisibleText: firstVisibleText(),
    renderedRowCount: renderedRowCount(),
    scrollTop: document.querySelector<HTMLDivElement>('.ui-data-grid-scroll')?.scrollTop ?? 0,
    scrollLeft: document.querySelector<HTMLDivElement>('.ui-data-grid-scroll')?.scrollLeft ?? 0,
    anchorRow: currentAnchor(scroll.anchorRow ?? Math.floor(scroll.top / 30)),
  }), [scroll.anchorRow, scroll.top, visibleCount]);

  useEffect(() => {
    const measure = async (action: () => void): Promise<SharedGridMeasurement> => {
      const startedAt = performance.now();
      action();
      await waitForFrame();
      const current = snapshot();
      return { ...current, durationMs: performance.now() - startedAt };
    };
    window.__sharedDataGrid = {
      profile,
      rowCount: rows.length,
      columnCount: columns.length,
      rows,
      measureFilter: query => measure(() => setView(previous => ({ ...previous, globalFilter: query, sorting: [] }))),
      measureSort: descending => measure(() => setView(previous => ({ ...previous, globalFilter: '', sorting: [{ column: 'ID', descending }] }))),
      measureScroll: (top, left) => measure(() => {
        const next = { sourceId: 'shared-harness', resultSetId, top, left, anchorRow: Math.floor(top / 30) };
        setScroll(next);
        const scroller = document.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
        if (scroller) {
          scroller.scrollTop = top;
          scroller.scrollLeft = left;
          scroller.dispatchEvent(new Event('scroll'));
        }
      }),
      snapshot,
    };
    setReady(true);
  }, [resultSetId, snapshot]);

  return <main className="shared-grid-harness" data-result-set-id={resultSetId} data-ready={ready ? 'true' : 'false'}>
    <header><strong>Shared Result Grid fixture</strong><span id="shared-profile">{profile}</span><span id="shared-row-count">{rows.length}</span><span id="shared-visible-count">{visibleCount}</span><span id="shared-anchor">{scroll.anchorRow ?? 0}</span></header>
    <DataGrid sourceId="shared-harness" resultSetId={resultSetId} columns={columns} rows={rows} totalRowCount={rows.length} view={view} onViewChange={patch => setView(previous => ({ ...previous, ...patch }))} scroll={scroll} onScroll={onScroll} />
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
