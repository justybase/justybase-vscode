import type { QueryColumnFilterSpec, QueryPageRequest, QuerySortSpec } from '@justybase/contracts';
import type { UiResultColumn, UiResultViewState } from './types';

export type UiResultQueryOptions = Pick<QueryPageRequest, 'globalFilter' | 'columnFilters' | 'sorting'>;

/** Resolves a persisted semantic or legacy positional column key. */
export function resolveUiResultColumnIndex(columns: readonly UiResultColumn[], key: string): number {
  const exact = columns.findIndex(column => column.name === key);
  if (exact >= 0) return exact;
  const folded = key.trim().toLocaleLowerCase();
  if (folded) {
    const insensitive = columns.findIndex(column => column.name.trim().toLocaleLowerCase() === folded);
    if (insensitive >= 0) return insensitive;
  }
  if (/^[0-9]+$/u.test(key)) {
    const positional = Number(key);
    if (positional >= 0 && positional < columns.length) return positional;
  }
  return -1;
}

/** Converts shared view state to the strict API query shape. */
export function toUiResultQueryOptions(
  columns: readonly UiResultColumn[],
  view: Pick<UiResultViewState, 'globalFilter' | 'columnFilters' | 'sorting'>,
): UiResultQueryOptions {
  const columnFilters: QueryColumnFilterSpec[] = Object.entries(view.columnFilters)
    .flatMap(([key, value]) => {
      const columnIndex = resolveUiResultColumnIndex(columns, key);
      return columnIndex >= 0 && value.trim().length > 0 ? [{ columnIndex, value }] : [];
    });
  const sorting: QuerySortSpec[] = view.sorting.flatMap(item => {
    const columnIndex = resolveUiResultColumnIndex(columns, item.column);
    return columnIndex >= 0 ? [{ columnIndex, desc: item.descending }] : [];
  });
  return {
    ...(view.globalFilter.trim().length > 0 ? { globalFilter: view.globalFilter } : {}),
    ...(columnFilters.length > 0 ? { columnFilters } : {}),
    ...(sorting.length > 0 ? { sorting } : {}),
  };
}
