/**
 * Webview-local copies of query history message contracts.
 * Keeps `tsc --project tsconfig.media.json` from pulling src/core into the graph.
 */

export type QueryExecutionStatus = 'success' | 'error' | 'cancelled';

export interface QueryHistoryEntryDto {
    id: string;
    host: string;
    database: string;
    schema: string;
    query: string;
    timestamp: number;
    connectionName?: string;
    is_favorite: boolean;
    tags?: string;
    description?: string;
    status?: QueryExecutionStatus;
    durationMs?: number;
    rowsAffected?: number;
    errorMessage?: string;
}

export interface QueryHistoryStatsDto {
    activeEntries: number;
    archivedEntries: number;
    totalEntries: number;
    activeFileSizeMB: number;
    archiveFileSizeMB: number;
    totalFileSizeMB: number;
}

export interface HistoryFilter {
    searchTerm?: string;
    tags?: string[];
    hosts?: string[];
    databases?: string[];
    connectionNames?: string[];
    dateFrom?: number;
    dateTo?: number;
    favoritesOnly?: boolean;
    caseSensitive?: boolean;
    status?: QueryExecutionStatus;
}

export interface QueryHistorySavedViewDto {
    id: string;
    name: string;
    description?: string;
    filter: HistoryFilter;
    createdAt: number;
    updatedAt?: number;
}

export interface QueryHistoryParameterDto {
    name: string;
    value: string;
    type: 'string' | 'number' | 'date' | 'boolean';
    required: boolean;
    defaultValue?: string;
}

export type QueryHistoryRecoveryActionType = 'refresh' | 'getHistory' | 'getSavedViews';

export interface QueryHistoryRecoveryAction {
    label: string;
    messageType: QueryHistoryRecoveryActionType;
}

export type QueryHistoryUiState =
    | {
          kind: 'loading';
          scope: 'history' | 'search' | 'savedViews' | 'quickRerun';
          message: string;
      }
    | {
          kind: 'empty';
          scope: 'history' | 'search' | 'savedViews';
          title: string;
          detail: string;
          stats?: QueryHistoryStatsDto;
          action?: QueryHistoryRecoveryAction;
      }
    | {
          kind: 'error';
          scope: 'history' | 'search' | 'savedViews' | 'quickRerun';
          title: string;
          detail: string;
          action?: QueryHistoryRecoveryAction;
      };

export type QueryHistoryMessageSource = 'active' | 'active+archive';

export type QueryHistoryWebviewToHostMessage =
    | { type: 'refresh' }
    | { type: 'loadMore' }
    | { type: 'searchArchive'; term: string }
    | { type: 'search'; term: string }
    | { type: 'clearAll' }
    | { type: 'deleteEntry'; id: string; query?: string }
    | { type: 'copyQuery'; query: string }
    | { type: 'executeQuery'; query: string }
    | { type: 'getHistory' }
    | { type: 'toggleFavorite'; id: string }
    | { type: 'updateEntry'; id: string; tags?: string; description?: string }
    | { type: 'requestEdit'; id: string }
    | { type: 'requestTagFilter'; tags: string[] }
    | { type: 'showFavoritesOnly' }
    | { type: 'filterByTag'; tag: string }
    | { type: 'filterByStatus'; status: QueryExecutionStatus | 'all' }
    | { type: 'showExtendedView' }
    | { type: 'exportHistory' }
    | { type: 'getSavedViews' }
    | { type: 'saveView'; name: string; filter: HistoryFilter; description?: string }
    | { type: 'deleteView'; viewId: string }
    | { type: 'applyView'; viewId: string }
    | { type: 'parseQueryParameters'; query: string }
    | { type: 'quickRerun'; queryId: string; parameters: QueryHistoryParameterDto[] };

export type QueryHistoryHostToWebviewMessage =
    | {
          type: 'historyData';
          history: QueryHistoryEntryDto[];
          stats: QueryHistoryStatsDto;
          reset?: boolean;
          filter?: string;
      }
    | {
          type: 'searchResults';
          history: QueryHistoryEntryDto[];
          stats: QueryHistoryStatsDto;
          term: string;
          source: QueryHistoryMessageSource;
      }
    | {
          type: 'archiveSearchResults';
          history: QueryHistoryEntryDto[];
          stats: QueryHistoryStatsDto;
          term: string;
      }
    | { type: 'entryDeleted'; id: string }
    | { type: 'entryAdded'; entry: QueryHistoryEntryDto; stats: QueryHistoryStatsDto }
    | { type: 'updateStats'; stats: QueryHistoryStatsDto }
    | { type: 'debug'; msg?: string }
    | { type: 'savedViewsData'; views: QueryHistorySavedViewDto[] }
    | { type: 'viewSaved'; view: QueryHistorySavedViewDto }
    | { type: 'viewDeleted'; viewId: string }
    | { type: 'queryParameters'; parameters: QueryHistoryParameterDto[] }
    | { type: 'uiState'; state: QueryHistoryUiState };

export interface QueryHistoryWebviewStateSnapshot {
    allHistory: QueryHistoryEntryDto[];
    savedViews: QueryHistorySavedViewDto[];
    currentFilter: string | null;
    pendingQuickRerunId: string | null;
    currentUiState: QueryHistoryUiState | null;
}

export interface QueryHistoryExtendedStateSnapshot {
    selectedEntryId: string | null;
    pendingQuickRerunId: string | null;
    currentUiState: QueryHistoryUiState | null;
}
