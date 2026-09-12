import type { PersistenceScope, UiIdentity } from '@justybase/contracts';
import type { UiResultViewState } from './types';
import { PersistenceCodec, PersistenceDecodeError } from './persistence';

export const RESULT_VIEW_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export interface ResultViewPersistencePayload {
  readonly view: UiResultViewState;
}

export interface ResultViewPersistenceOptions {
  readonly scope: PersistenceScope;
  readonly identity: UiIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined;
  return value;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'string')) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function booleanRecord(value: unknown): Readonly<Record<string, boolean>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'boolean')) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, boolean>>;
}

function widthRecord(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'number' && Number.isFinite(item) && item >= 0)) return undefined;
  return Object.fromEntries(entries.map(([key, item]) => [key, Math.min(4096, item as number)])) as Readonly<Record<string, number>>;
}

function sorting(value: unknown): UiResultViewState['sorting'] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(item => isRecord(item) && typeof item.column === 'string' && typeof item.descending === 'boolean')) return undefined;
  return value.map(item => ({ column: item.column as string, descending: item.descending as boolean }));
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Validates and normalises only the portable view portion of a result grid.
 * Result rows, query text, credentials and runtime handles are intentionally
 * outside this shape and therefore cannot be persisted by this codec.
 */
export function normalizeResultView(value: unknown): UiResultViewState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.globalFilter !== undefined && typeof value.globalFilter !== 'string') return undefined;
  if (value.columnFilters !== undefined && stringRecord(value.columnFilters) === undefined) return undefined;
  if (value.sorting !== undefined && sorting(value.sorting) === undefined) return undefined;
  if (value.grouping !== undefined && stringArray(value.grouping) === undefined) return undefined;
  if (value.aggregation !== undefined && typeof value.aggregation !== 'string') return undefined;
  if (value.pivotColumn !== undefined && typeof value.pivotColumn !== 'string') return undefined;
  if (value.columnVisibility !== undefined && booleanRecord(value.columnVisibility) === undefined) return undefined;
  if (value.columnOrder !== undefined && stringArray(value.columnOrder) === undefined) return undefined;
  if (value.pinnedColumns !== undefined && stringArray(value.pinnedColumns) === undefined) return undefined;
  if (value.columnWidths !== undefined && widthRecord(value.columnWidths) === undefined) return undefined;
  if (value.scrollTop !== undefined && nonNegativeNumber(value.scrollTop) === undefined) return undefined;
  if (value.scrollLeft !== undefined && nonNegativeNumber(value.scrollLeft) === undefined) return undefined;
  if (value.anchorRow !== undefined && nonNegativeInteger(value.anchorRow) === undefined) return undefined;

  const next = {
    globalFilter: typeof value.globalFilter === 'string' ? value.globalFilter : '',
    columnFilters: value.columnFilters === undefined ? {} : stringRecord(value.columnFilters)!,
    sorting: value.sorting === undefined ? [] : sorting(value.sorting)!,
    grouping: value.grouping === undefined ? [] : stringArray(value.grouping)!,
    scrollTop: value.scrollTop === undefined ? 0 : nonNegativeNumber(value.scrollTop)!,
    scrollLeft: value.scrollLeft === undefined ? 0 : nonNegativeNumber(value.scrollLeft)!,
    ...(typeof value.aggregation === 'string' ? { aggregation: value.aggregation } : {}),
    ...(typeof value.pivotColumn === 'string' ? { pivotColumn: value.pivotColumn } : {}),
    ...(value.columnVisibility !== undefined ? { columnVisibility: booleanRecord(value.columnVisibility)! } : {}),
    ...(value.columnOrder !== undefined ? { columnOrder: stringArray(value.columnOrder)! } : {}),
    ...(value.pinnedColumns !== undefined ? { pinnedColumns: stringArray(value.pinnedColumns)! } : {}),
    ...(value.columnWidths !== undefined ? { columnWidths: widthRecord(value.columnWidths)! } : {}),
    ...(value.anchorRow !== undefined ? { anchorRow: nonNegativeInteger(value.anchorRow)! } : {}),
  } satisfies UiResultViewState;
  return next;
}

export function isResultViewPersistencePayload(value: unknown): value is ResultViewPersistencePayload {
  return isRecord(value) && normalizeResultView(value.view) !== undefined;
}

export function createResultViewPersistenceCodec(options: ResultViewPersistenceOptions): PersistenceCodec<ResultViewPersistencePayload> {
  return new PersistenceCodec({
    schemaVersion: RESULT_VIEW_PERSISTENCE_SCHEMA_VERSION,
    scope: options.scope,
    identity: options.identity,
    validatePayload: isResultViewPersistencePayload,
  });
}

export function resultViewPersistenceKey(resultSetId: string): string {
  return `result_view_v1_${encodeURIComponent(resultSetId)}`;
}

export function resultViewPersistenceIdentity(identity: UiIdentity, resultSetId: string): UiIdentity {
  return { ...identity, resultSetId };
}

export function encodePersistedResultView(view: UiResultViewState, options: ResultViewPersistenceOptions): string {
  const normalized = normalizeResultView(view);
  if (!normalized) throw new PersistenceDecodeError('Result view state failed persistence validation.');
  return createResultViewPersistenceCodec(options).encode({ view: normalized });
}

export function decodePersistedResultView(value: unknown, options: ResultViewPersistenceOptions): UiResultViewState | undefined {
  try {
    const envelope = createResultViewPersistenceCodec(options).decode(value);
    return envelope ? normalizeResultView(envelope.payload.view) : undefined;
  } catch {
    return undefined;
  }
}

function parseLegacyValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function legacyColumnFilters(value: unknown): Readonly<Record<string, string>> | undefined {
  if (Array.isArray(value)) {
    if (!value.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.value === 'string')) return undefined;
    return Object.fromEntries(value.map(item => [item.id as string, item.value as string]));
  }
  return stringRecord(value);
}

function legacySorting(value: unknown): UiResultViewState['sorting'] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(item => isRecord(item) && (typeof item.column === 'string' && typeof item.descending === 'boolean' || typeof item.id === 'string' && typeof item.desc === 'boolean'))) return undefined;
  return value.map(item => isRecord(item) && typeof item.column === 'string'
    ? { column: item.column, descending: item.descending as boolean }
    : { column: item.id as string, descending: item.desc as boolean });
}

function legacyPinnedColumns(value: unknown): readonly string[] | undefined {
  if (!isRecord(value)) return undefined;
  const left = stringArray(value.left);
  const right = stringArray(value.right);
  if (left === undefined || right === undefined) return undefined;
  return [...left, ...right];
}

/** Converts the pre-shared Web grid envelope to the portable view shape. */
export function decodeLegacyResultView(value: unknown, expectedResultSetId?: string): UiResultViewState | undefined {
  const envelope = parseLegacyValue(value);
  if (!envelope) return undefined;
  if (envelope.version === 2 && expectedResultSetId !== undefined && envelope.resultSetId !== expectedResultSetId) return undefined;
  if (envelope.resultSetId !== undefined && expectedResultSetId !== undefined && envelope.resultSetId !== expectedResultSetId) return undefined;
  const state = envelope.version === 2 && isRecord(envelope.state) ? envelope.state : envelope;
  const columnFilters = state.columnFilters === undefined ? undefined : legacyColumnFilters(state.columnFilters);
  const sortingValue = state.sorting === undefined ? undefined : legacySorting(state.sorting);
  if (state.columnFilters !== undefined && columnFilters === undefined) return undefined;
  if (state.sorting !== undefined && sortingValue === undefined) return undefined;
  return normalizeResultView({
    globalFilter: state.globalFilter,
    columnFilters,
    sorting: sortingValue,
    grouping: state.grouping,
    columnVisibility: state.columnVisibility,
    columnOrder: state.columnOrder,
    pinnedColumns: state.columnPinning === undefined ? state.pinnedColumns : legacyPinnedColumns(state.columnPinning),
    columnWidths: state.columnWidths,
    scrollTop: state.scrollTop,
    scrollLeft: state.scrollLeft,
    anchorRow: state.scrollAnchorRow ?? state.anchorRow,
    aggregation: state.aggregation,
    pivotColumn: state.pivotColumn,
  });
}
