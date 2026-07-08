import type { HistoryFilter, QueryParameter } from '../../core/queryHistoryManager';
import type { HistoryStats, QueryHistoryEntry, QueryExecutionStatus, SavedFilterView } from '../../core/history/types';
export type { QueryExecutionStatus };

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

export type QueryHistoryStatsDto = HistoryStats;

export type QueryHistorySavedViewDto = SavedFilterView;

export type QueryHistoryParameterDto = QueryParameter;

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
    | { type: 'historyData'; history: QueryHistoryEntryDto[]; stats: QueryHistoryStatsDto; reset?: boolean; filter?: string }
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

export type QueryHistoryInboundMessage = QueryHistoryWebviewToHostMessage;
export type QueryHistoryOutboundMessage = QueryHistoryHostToWebviewMessage;

export const QUERY_HISTORY_WEBVIEW_TO_HOST_TYPES = [
    'refresh',
    'loadMore',
    'searchArchive',
    'search',
    'clearAll',
    'deleteEntry',
    'copyQuery',
    'executeQuery',
    'getHistory',
    'toggleFavorite',
    'updateEntry',
    'requestEdit',
    'requestTagFilter',
    'showFavoritesOnly',
    'filterByTag',
    'filterByStatus',
    'showExtendedView',
    'exportHistory',
    'getSavedViews',
    'saveView',
    'deleteView',
    'applyView',
    'parseQueryParameters',
    'quickRerun'
] as const satisfies readonly QueryHistoryWebviewToHostMessage['type'][];

export const QUERY_HISTORY_HOST_TO_WEBVIEW_TYPES = [
    'historyData',
    'searchResults',
    'archiveSearchResults',
    'entryDeleted',
    'entryAdded',
    'updateStats',
    'debug',
    'savedViewsData',
    'viewSaved',
    'viewDeleted',
    'queryParameters',
    'uiState'
] as const satisfies readonly QueryHistoryHostToWebviewMessage['type'][];

export const QUERY_HISTORY_INBOUND_TYPES = QUERY_HISTORY_WEBVIEW_TO_HOST_TYPES;
export const QUERY_HISTORY_OUTBOUND_TYPES = QUERY_HISTORY_HOST_TO_WEBVIEW_TYPES;

export function toQueryHistoryEntryDto(entry: QueryHistoryEntry): QueryHistoryEntryDto {
    return {
        id: entry.id,
        host: entry.host,
        database: entry.database,
        schema: entry.schema,
        query: entry.query,
        timestamp: entry.timestamp,
        connectionName: entry.connectionName,
        is_favorite: Boolean(entry.is_favorite),
        tags: entry.tags,
        description: entry.description,
        status: entry.status,
        durationMs: entry.durationMs,
        rowsAffected: entry.rowsAffected,
        errorMessage: entry.errorMessage,
    };
}

export function toQueryHistoryEntryDtos(entries: QueryHistoryEntry[]): QueryHistoryEntryDto[] {
    return entries.map(toQueryHistoryEntryDto);
}