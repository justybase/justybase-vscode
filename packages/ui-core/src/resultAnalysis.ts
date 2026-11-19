import type { QueryAggregateResponse, QueryGroupResponse } from '@justybase/contracts';
import type { UiResultColumn } from './types';

export type UiResultAnalysisKind = 'aggregate' | 'group' | 'pivot';

/** Serializable result table produced by an adapter-side analysis request. */
export interface UiResultAnalysisTable {
  readonly kind: UiResultAnalysisKind;
  readonly title: string;
  readonly summary?: string;
  readonly columns: readonly UiResultColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly totalRowCount?: number;
}

function columnType(column: UiResultColumn | undefined): UiResultColumn {
  return column ? { ...column } : { name: 'Value' };
}

/** Maps the aggregate result DTO to the portable table consumed by renderers. */
export function createAggregateAnalysisTable(
  columns: readonly UiResultColumn[],
  response: QueryAggregateResponse,
): UiResultAnalysisTable {
  const outputColumns: readonly UiResultColumn[] = [
    { name: 'Column' },
    { name: 'Count', type: 'BIGINT' },
    { name: 'Sum' },
    { name: 'Average' },
    { name: 'Min' },
    { name: 'Max' },
  ];
  const rows = response.values.map(value => [
    columns[value.columnIndex]?.name ?? `Column ${value.columnIndex + 1}`,
    value.count,
    value.sum ?? null,
    value.avg ?? null,
    value.min ?? null,
    value.max ?? null,
  ]);
  return {
    kind: 'aggregate',
    title: 'Aggregates',
    summary: `For ${response.filteredRowCount.toLocaleString()} filtered rows`,
    columns: outputColumns,
    rows,
    totalRowCount: rows.length,
  };
}

/** Maps grouped result output without changing row values or decimal strings. */
export function createGroupAnalysisTable(response: QueryGroupResponse): UiResultAnalysisTable {
  const rows = response.rows.map(row => row.slice());
  const truncated = response.totalGroups > rows.length;
  return {
    kind: 'group',
    title: 'Grouped result',
    summary: truncated
      ? `First ${rows.length.toLocaleString()} of ${response.totalGroups.toLocaleString()} groups`
      : `${response.totalGroups.toLocaleString()} groups`,
    columns: response.columns.map(columnType),
    rows,
    totalRowCount: rows.length,
  };
}

/**
 * Converts a two-dimensional grouped response into a stable pivot table.
 * `response.rows` is expected to contain row dimension, pivot dimension, and
 * one aggregate value in that order, as returned by the group endpoint.
 */
export function createPivotAnalysisTable(
  columns: readonly UiResultColumn[],
  response: QueryGroupResponse & { readonly truncated?: boolean },
  rowColumnIndex: number,
  _pivotColumnIndex: number,
  valueColumnIndex: number,
  aggregationLabel?: string,
): UiResultAnalysisTable {
  /** Bounds the rendered matrix: pivot cardinality is unbounded server-side. */
  const MAX_PIVOT_VALUES = 500;
  /** Distinguishes SQL NULL from the literal string "NULL" in pivot keys. */
  const keyOf = (value: unknown): string => value === null || value === undefined ? '\u0000NULL' : String(value);
  const labelOf = (value: unknown): string => value === null || value === undefined ? 'NULL' : String(value);
  const pivotLabels = new Map<string, string>();
  const rowLabels = new Map<string, string>();
  for (const row of response.rows) {
    pivotLabels.set(keyOf(row[1]), labelOf(row[1]));
    rowLabels.set(keyOf(row[0]), labelOf(row[0]));
  }
  const pivotKeys = [...pivotLabels.keys()];
  const rowKeys = [...rowLabels.keys()];
  const visiblePivotKeys = pivotKeys.slice(0, MAX_PIVOT_VALUES);
  const visiblePivotSet = new Set(visiblePivotKeys);
  const rowMap = new Map<string, Map<string, unknown>>();
  for (const row of response.rows) {
    const rowKey = keyOf(row[0]);
    const pivotKey = keyOf(row[1]);
    if (!visiblePivotSet.has(pivotKey)) continue;
    const values = rowMap.get(rowKey) ?? new Map<string, unknown>();
    values.set(pivotKey, row[2] ?? null);
    rowMap.set(rowKey, values);
  }
  const valueColumn = columns[valueColumnIndex];
  const pivotColumns: UiResultColumn[] = [
    columnType(columns[rowColumnIndex]),
    ...visiblePivotKeys.map(key => ({
      name: pivotLabels.get(key) ?? 'NULL',
      ...(valueColumn?.type === undefined ? {} : { type: valueColumn.type }),
      ...(valueColumn?.scale === undefined ? {} : { scale: valueColumn.scale }),
    })),
  ];
  const rows = rowKeys.map(rowKey => [rowLabels.get(rowKey) ?? 'NULL', ...visiblePivotKeys.map(pivotKey => rowMap.get(rowKey)?.get(pivotKey) ?? null)]);
  const partial = response.truncated === true;
  const truncated = partial || response.totalGroups > response.rows.length;
  const baseSummary = `${rowKeys.length.toLocaleString()} rows · ${visiblePivotKeys.length.toLocaleString()} pivot values`;
  const pivotCapped = pivotKeys.length > visiblePivotKeys.length
    ? `${baseSummary} · first ${visiblePivotKeys.length.toLocaleString()} of ${pivotKeys.length.toLocaleString()} pivot values`
    : baseSummary;
  const summaryPrefix = aggregationLabel ? `${aggregationLabel} · ` : '';
  const truncationNote = partial
    ? `partial: first ${response.rows.length.toLocaleString()} groups`
    : `first ${response.rows.length.toLocaleString()} of ${response.totalGroups.toLocaleString()} groups`;
  return {
    kind: 'pivot',
    title: 'Pivot result',
    summary: truncated
      ? `${summaryPrefix}${pivotCapped} · ${truncationNote}`
      : `${summaryPrefix}${pivotCapped}`,
    columns: pivotColumns,
    rows,
    totalRowCount: rows.length,
  };
}
