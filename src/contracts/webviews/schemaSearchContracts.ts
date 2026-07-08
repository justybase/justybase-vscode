export type SchemaSearchSourceMode = 'raw' | 'noComments' | 'noCommentsNoLiterals';

export type SchemaSearchLayoutMode = 'compact' | 'standard';

export type SchemaSearchSortMode = 'db_name' | 'name' | 'type_name';

export type SchemaSearchUiSourceMode = '' | 'raw' | 'objectsRaw' | 'noComments' | 'noCommentsNoLiterals';

export interface SchemaSearchResultItem {
    NAME: string;
    SCHEMA: string;
    DATABASE: string;
    TYPE: string;
    PARENT: string;
    DESCRIPTION: string;
    MATCH_TYPE: string;
    connectionName?: string;
}

export interface SchemaSearchConnectionOption {
    name: string;
    label: string;
}

export interface SchemaSearchNavigateTarget {
    database: string;
    schema: string;
    name: string;
    objType: string;
    parent: string;
    connectionName?: string;
}

export interface SchemaSearchFacetOptions {
    types: string[];
    schemas: string[];
    matchTypes: string[];
}

export interface SchemaSearchPersistedState {
    sessionId: string;
    layout: SchemaSearchLayoutMode;
    sortBy: SchemaSearchSortMode;
    searchTerm: string;
    sourceMode: SchemaSearchUiSourceMode;
    connectionName: string;
    results: SchemaSearchResultItem[];
    typeFilter?: string;
    schemaFilter?: string;
    matchTypeFilter?: string;
}

export type SchemaSearchWebviewToHostMessage =
    | { type: 'search'; value: string; connectionName?: string }
    | { type: 'searchSource'; value: string; mode: SchemaSearchSourceMode; connectionName?: string }
    | { type: 'searchCombined'; value: string; mode: SchemaSearchSourceMode; connectionName?: string }
    | { type: 'requestConnections' }
    | { type: 'requestRecents'; connectionName?: string }
    | ({ type: 'navigate' } & SchemaSearchNavigateTarget)
    | { type: 'cancel' }
    | { type: 'reset' }
    | { type: 'exportXlsb'; results: SchemaSearchResultItem[] };

export type SchemaSearchHostToWebviewMessage =
    | { type: 'results'; data: SchemaSearchResultItem[]; append: boolean; sentIds?: string[]; facets?: SchemaSearchFacetOptions }
    | { type: 'searching'; message: string }
    | { type: 'error'; message: string }
    | { type: 'cancelled' }
    | { type: 'reset' }
    | { type: 'connections'; connections: SchemaSearchConnectionOption[] }
    | { type: 'recents'; data: SchemaSearchResultItem[] };

export type SchemaSearchInboundMessage = SchemaSearchWebviewToHostMessage;
export type SchemaSearchOutboundMessage = SchemaSearchHostToWebviewMessage;

export const SCHEMA_SEARCH_WEBVIEW_TO_HOST_TYPES = [
    'search',
    'searchSource',
    'searchCombined',
    'requestConnections',
    'requestRecents',
    'navigate',
    'cancel',
    'reset',
    'exportXlsb'
] as const satisfies readonly SchemaSearchWebviewToHostMessage['type'][];

export const SCHEMA_SEARCH_HOST_TO_WEBVIEW_TYPES = [
    'results',
    'searching',
    'error',
    'cancelled',
    'reset',
    'connections',
    'recents'
] as const satisfies readonly SchemaSearchHostToWebviewMessage['type'][];

export const SCHEMA_SEARCH_INBOUND_TYPES = SCHEMA_SEARCH_WEBVIEW_TO_HOST_TYPES;
export const SCHEMA_SEARCH_OUTBOUND_TYPES = SCHEMA_SEARCH_HOST_TO_WEBVIEW_TYPES;