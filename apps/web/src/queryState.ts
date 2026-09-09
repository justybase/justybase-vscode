import type { QueryEvent } from '@justybase/contracts';
import {
  applyPortableQueryEvent,
  emptyPortableQueryResult,
  type PortableQueryEvent,
  type PortableQueryResultState,
} from '@justybase/result-core';

export type ResultState = PortableQueryResultState;

export const emptyResult: ResultState = emptyPortableQueryResult;

export function applyQueryEvent(previous: ResultState, event: QueryEvent): ResultState {
  return applyPortableQueryEvent(previous, event as PortableQueryEvent);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
