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

/** Maps the API aggregate DTO to the portable table consumed by renderers. */
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

/** Maps grouped API output without changing row values or decimal strings. */
export function createGroupAnalysisTable(response: QueryGroupResponse): UiResultAnalysisTable {
  const rows = response.rows.map(row => row.slice());
  return {
    kind: 'group',
    title: 'Grouped result',
    summary: `${response.totalGroups.toLocaleString()} groups`,
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
  response: QueryGroupResponse,
  rowColumnIndex: number,
  _pivotColumnIndex: number,
  valueColumnIndex: number,
): UiResultAnalysisTable {
  const pivotValues = [...new Set(response.rows.map(row => String(row[1] ?? 'NULL')))];
  const rowValues = [...new Set(response.rows.map(row => String(row[0] ?? 'NULL')))];
  const rowMap = new Map<string, Map<string, unknown>>();
  for (const row of response.rows) {
    const rowKey = String(row[0] ?? 'NULL');
    const values = rowMap.get(rowKey) ?? new Map<string, unknown>();
    values.set(String(row[1] ?? 'NULL'), row[2] ?? null);
    rowMap.set(rowKey, values);
  }
  const valueColumn = columns[valueColumnIndex];
  const pivotColumns: UiResultColumn[] = [
    columnType(columns[rowColumnIndex]),
    ...pivotValues.map(value => ({
      name: value,
      ...(valueColumn?.type === undefined ? {} : { type: valueColumn.type }),
      ...(valueColumn?.scale === undefined ? {} : { scale: valueColumn.scale }),
    })),
  ];
  const rows = rowValues.map(rowValue => [rowValue, ...pivotValues.map(pivotValue => rowMap.get(rowValue)?.get(pivotValue) ?? null)]);
  return {
    kind: 'pivot',
    title: 'Pivot result',
    summary: `${rowValues.length.toLocaleString()} rows · ${pivotValues.length.toLocaleString()} pivot values`,
    columns: pivotColumns,
    rows,
    totalRowCount: rows.length,
  };
}
