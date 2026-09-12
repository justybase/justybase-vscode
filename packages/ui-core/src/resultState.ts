import type { UiResultSurfaceState } from './types';

export type UiResultAsyncState = 'loading' | 'empty' | 'error' | 'cancelled' | 'ready';

export interface UiResultAsyncStateOptions {
  /** Product-specific policy for a stream whose total row count is still zero. */
  readonly streamingEmpty: 'loading' | 'ready';
  /** Product-specific policy when rows exist remotely but none match locally yet. */
  readonly streamingWithUnloadedRows: 'loading' | 'ready';
}

/** Shared loading/empty decision for streamed result surfaces. */
export function resultAsyncState(
  result: UiResultSurfaceState | undefined,
  rowCount: number,
  options: UiResultAsyncStateOptions = { streamingEmpty: 'loading', streamingWithUnloadedRows: 'ready' },
): UiResultAsyncState {
  if (!result) return 'empty';
  if (result.status === 'error') return 'error';
  if (result.status === 'cancelled') return 'cancelled';
  const hasViewFilter = result.view.globalFilter.trim().length > 0
    || Object.values(result.view.columnFilters).some(value => value.trim().length > 0);
  const rowsMayBeOutsideView = result.totalRowCount > 0
    && (hasViewFilter || result.loadedRowCount < result.totalRowCount);
  if (result.status === 'loading') return 'loading';
  if (result.status === 'streaming' && rowCount === 0) {
    return rowsMayBeOutsideView ? options.streamingWithUnloadedRows : options.streamingEmpty;
  }
  if (result.status === 'empty' || (rowCount === 0 && !rowsMayBeOutsideView)) return 'empty';
  return 'ready';
}
