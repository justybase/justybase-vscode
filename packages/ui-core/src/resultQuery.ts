import type { QueryColumnFilterSpec, QueryPageRequest, QuerySortSpec } from '@justybase/contracts';
import type { UiResultColumn, UiResultViewState } from './types';

export type UiResultQueryOptions = Pick<QueryPageRequest, 'globalFilter' | 'columnFilters' | 'sorting'>;
type UiResultQueryView = Pick<UiResultViewState, 'globalFilter' | 'columnFilters' | 'columnFilterDefinitions' | 'sorting'>;

/** Returns whether a result view contains criteria that must be applied to rows. */
export function hasUiResultQuery(view: UiResultQueryView): boolean {
  return view.globalFilter.trim().length > 0
    || Object.values(view.columnFilters).some(value => value.trim().length > 0)
    || Object.values(view.columnFilterDefinitions ?? {}).some(definition => definition.operator !== 'in' || (definition.values?.length ?? 0) > 0)
    || view.sorting.length > 0;
}

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
  view: UiResultQueryView,
): UiResultQueryOptions {
  const filterKeys = new Set([...Object.keys(view.columnFilters), ...Object.keys(view.columnFilterDefinitions ?? {})]);
  const columnFilters: QueryColumnFilterSpec[] = [...filterKeys]
    .flatMap(key => {
      const value = view.columnFilters[key] ?? '';
      const columnIndex = resolveUiResultColumnIndex(columns, key);
      const definition = view.columnFilterDefinitions?.[key];
      if (columnIndex < 0 || !definition && value.trim().length === 0) return [];
      if (definition) {
        return definition.operator === 'in' && (!definition.values || definition.values.length === 0)
          ? []
          : [{ columnIndex, value: definition.value, operator: definition.operator, ...(definition.values === undefined ? {} : { values: definition.values }) }];
      }
      return [{ columnIndex, value }];
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
