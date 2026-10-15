/** Product-neutral contracts for result exploration. Numeric bounds stay exact. */
export type ExploreDateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ExploreValue = string | number | boolean;
export interface ExploreDimensionFilter {
    columnIndex: number;
    values: ExploreValue[];
    mode?: 'include' | 'exclude';
    includeNull?: boolean;
    includeEmpty?: boolean;
}
export interface ExploreDateFilter {
    columnIndex: number;
    grain: ExploreDateGrain;
    from?: string;
    to?: string;
    toExclusive?: boolean;
}
export interface ExploreMeasureFilter {
    columnIndex: number;
    min?: number | string;
    max?: number | string;
    maxExclusive?: boolean;
}
export interface ExploreFilterModel {
    dimensions: ExploreDimensionFilter[];
    dates: ExploreDateFilter[];
    measures: ExploreMeasureFilter[];
}
export interface ExploreRankingConfig {
    categoryColumnIndex: number;
    measureColumnIndex?: number;
    aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'countDistinct';
    direction: 'top' | 'bottom';
    count: number;
    showShare: boolean;
    includeOther: boolean;
    filters?: ExploreFilterModel;
}
export interface ExplorePivotConfig {
    rowColumnIndexes: number[];
    columnColumnIndex: number;
    valueColumnIndex: number;
    aggFn: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';
    filters?: ExploreFilterModel;
    limit?: number;
}
export interface ExploreComposerConfig {
    dateColumnIndex: number;
    grain: ExploreDateGrain;
    dimensionColumnIndex?: number;
    measureColumnIndex: number;
    aggFn: 'sum' | 'avg' | 'count' | 'min' | 'max';
    splitByColumnIndex?: number;
    splitValues?: string[];
    includeOther?: boolean;
    comparePrevious: boolean;
    filters?: ExploreFilterModel;
    limit?: number;
}
export type ExploreOperation =
    | { kind: 'values'; columnIndex: number; search: string; filters: ExploreFilterModel }
    | { kind: 'rows'; filters: ExploreFilterModel }
    | { kind: 'ranking'; config: ExploreRankingConfig }
    | { kind: 'fullStats'; columnIndex: number; filters?: ExploreFilterModel }
    | { kind: 'composer'; config: ExploreComposerConfig }
    | { kind: 'pivot'; config: ExplorePivotConfig; pivotValues?: string[] };
export interface ExploreRequest {
    sourceUri: string;
    resultSetIndex: number;
    resultSetId?: string;
    requestId: number;
    operation: ExploreOperation;
    preview?: boolean;
    timeoutSeconds?: number;
}
export interface ExploreResponse {
    rows: unknown[][];
    sql: string;
    truncated: boolean;
    computedAt: number;
    scope: 'database';
    filters: ExploreFilterModel;
    values?: Partial<Record<'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max' | 'stddev' | 'p25' | 'p50' | 'p75', number | null>>;
    percentilesUnavailable?: boolean;
    stddevUnavailable?: boolean;
    columnIndexes?: { bucket: number; dimension: number | undefined; split: number | undefined; splitOther?: number; measure: number; previous: number | undefined };
    columns?: Array<{ name: string; type?: string; kind: 'row' | 'value' }>;
    pivotValues?: string[];
}
