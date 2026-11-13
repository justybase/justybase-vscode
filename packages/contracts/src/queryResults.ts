/**
 * Portable result-grid contracts shared by desktop webviews and companion UI
 * surfaces. These are product-neutral request/result shapes; they do not
 * describe a transport or a hosted service.
 */

/** Result metadata kept small enough for streaming/page responses. */
export interface QueryColumn {
  name: string;
  type?: string;
  scale?: number;
}

export interface QuerySortSpec {
  columnIndex: number;
  desc: boolean;
}

export type QueryColumnFilterOperator =
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'isNull'
  | 'isNotNull'
  | 'in';

/**
 * A filter keeps the original string value for compatibility with older
 * persisted views. New clients may additionally provide a typed operator and a
 * bounded list of raw values for Excel-style multi-select filtering.
 */
export interface QueryColumnFilterSpec {
  columnIndex: number;
  value: string;
  operator?: QueryColumnFilterOperator;
  values?: readonly unknown[];
}

export interface QueryPageRequest {
  /** Statement result within a script. Defaults to statement 0 for compatibility. */
  statementIndex?: number;
  offset?: number;
  limit?: number;
  globalFilter?: string;
  columnFilters?: QueryColumnFilterSpec[];
  sorting?: QuerySortSpec[];
}

export interface QueryAggregateValue {
  columnIndex: number;
  count: number;
  /** Numeric results may be strings to preserve 64-bit and decimal precision. */
  sum?: number | string | null;
  avg?: number | string | null;
  min?: unknown;
  max?: unknown;
}

export interface QueryAggregateResponse {
  statementIndex?: number;
  filteredRowCount: number;
  values: QueryAggregateValue[];
}

export interface QueryGroupResponse {
  statementIndex?: number;
  columns: QueryColumn[];
  rows: unknown[][];
  totalGroups: number;
}
