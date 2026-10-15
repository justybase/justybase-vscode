// Shared types for the result-panel Explore view.

/** Number of loaded rows used for client-side column classification and overview stats. */
export const EXPLORE_SAMPLE_ROWS = 50000;

/** Number of top values collected for dimension columns. */
export const EXPLORE_TOP_VALUES = 8;

/** Number of bins in the numeric distribution histogram. */
export const EXPLORE_HISTOGRAM_BINS = 20;

export type ExploreColumnRole = 'dimension' | 'measure' | 'date' | 'unknown';

export interface ExploreColumnMeta {
    index: number;
    name: string;
    type?: string;
    role: ExploreColumnRole;
    /** Top sample values for dimension columns (used for pivot column values). */
    exploreTopValues?: string[];
}

export interface ExploreHistogramBin {
    min: number;
    max: number;
    count: number;
}

export interface ExploreTopValue {
    value: string;
    count: number;
}

export interface ExploreColumnOverview {
    index: number;
    name: string;
    type?: string;
    role: ExploreColumnRole;
    /** Total rows that were examined (sample size). */
    examinedRows: number;
    nullCount: number;
    distinctCount: number;
    distinctTruncated: boolean;
    min?: number;
    max?: number;
    avg?: number;
    p25?: number;
    p75?: number;
    histogram?: ExploreHistogramBin[];
    topValues?: ExploreTopValue[];
    minDate?: string;
    maxDate?: string;
}

export interface ExploreOverviewResult {
    columns: ExploreColumnMeta[];
    overviews: ExploreColumnOverview[];
    totalRows: number;
    sampledRows: number;
    truncated: boolean;
    sampleMode: 'memory' | 'disk';
}

export type { ExploreDateGrain, ExploreDimensionFilter, ExploreDateFilter, ExploreMeasureFilter, ExploreFilterModel, ExploreRankingConfig, ExplorePivotConfig, ExploreComposerConfig } from '@justybase/contracts';
import type { ExploreFilterModel, ExploreRankingConfig, ExplorePivotConfig, ExploreComposerConfig } from '@justybase/contracts';

export type ExplorePivotAggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';

export type ExploreComposerAggregate = 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface ExplorePersistedState {
    version?: 2;
    activeTab?: 'cards' | 'pivot' | 'composer';
    chartMode?: 'time' | 'ranking';
    rankingConfig?: ExploreRankingConfig;
    schemaKey?: string;
    filters: ExploreFilterModel;
    pivotConfig?: ExplorePivotConfig;
    pivotValues?: string[];
    composerConfig?: ExploreComposerConfig;
}
