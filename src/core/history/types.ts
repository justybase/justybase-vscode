
export type QueryExecutionStatus = 'success' | 'error' | 'cancelled';

export interface QueryHistoryEntry {
    id: string;
    host: string;
    database: string;
    schema: string;
    query: string;
    timestamp: number;
    connectionName?: string;
    is_favorite?: boolean;
    tags?: string;
    description?: string;
    status?: QueryExecutionStatus;
    durationMs?: number;
    rowsAffected?: number;
    errorMessage?: string;
}

export interface StorageData {
    entries: QueryHistoryEntry[];
    version: number;
}

export interface HistoryStats {
    activeEntries: number;
    archivedEntries: number;
    totalEntries: number;
    activeFileSizeMB: number;
    archiveFileSizeMB: number;
    totalFileSizeMB: number;
}

/**
 * Saved filter view for query history
 */
export interface SavedFilterView {
    id: string;
    name: string;
    description?: string;
    filter: HistoryFilter;
    createdAt: number;
    updatedAt?: number;
}

/**
 * Filter criteria for query history
 */
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

/**
 * Quick rerun configuration with parameters
 */
export interface QuickRerunConfig {
    originalQuery: string;
    parameters: QueryParameter[];
    timestamp: number;
}

/**
 * Query parameter for quick rerun
 */
export interface QueryParameter {
    name: string;
    value: string;
    type: 'string' | 'number' | 'date' | 'boolean';
    required: boolean;
    defaultValue?: string;
}
