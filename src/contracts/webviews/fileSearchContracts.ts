export type FileSearchCommentMode = 'raw' | 'noComments' | 'noCommentsNoLiterals';
export type FileSearchGroupMode = 'flat' | 'grouped';
export type FileSearchMode = 'find' | 'replace';

export interface FileSearchOptions {
    term: string;
    replaceText: string;
    mode: FileSearchMode;
    commentMode: FileSearchCommentMode;
    groupMode: FileSearchGroupMode;
    /** Comma-separated glob patterns, VS Code style (e.g. `*.sql, src/**`). Empty = all files. */
    includePattern: string;
    /** Comma-separated glob patterns, applied on top of the built-in excludes. */
    excludePattern: string;
    /** Adds `files.exclude`, `search.exclude` and (when enabled) `.gitignore` rules. */
    useExcludeSettings: boolean;
    /** Restricts the search to files that have an open text tab. */
    searchOnlyOpenEditors: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

export interface FileSearchPatternHistory {
    include: string[];
    exclude: string[];
}

export interface FileMatch {
    line: number;
    lineContent: string;
    column: number;
}

export interface FileSearchResult {
    fileUri: string;
    fileName: string;
    relativePath: string;
    mtime: number;
    matchCount: number;
    matches: FileMatch[];
    isFileNameMatch?: boolean;
}

export type FileSearchWebviewToHostMessage =
    | { type: 'search'; options: FileSearchOptions }
    | { type: 'cancel' }
    | { type: 'openFile'; fileUri: string; line: number }
    | { type: 'reset' }
    | { type: 'replaceAll'; options: FileSearchOptions }
    | { type: 'ready' };

export type FileSearchHostToWebviewMessage =
    | { type: 'results'; data: FileSearchResult[]; fileMatches: FileSearchResult[]; groupMode: FileSearchGroupMode }
    | { type: 'searching'; message: string }
    | { type: 'error'; message: string }
    | { type: 'cancelled' }
    | { type: 'reset' }
    | { type: 'replaceDone'; modifiedCount: number; matchCount: number }
    | { type: 'history'; include: string[]; exclude: string[] };

export type FileSearchInboundMessage = FileSearchWebviewToHostMessage;
export type FileSearchOutboundMessage = FileSearchHostToWebviewMessage;

export const FILE_SEARCH_WEBVIEW_TO_HOST_TYPES = [
    'search',
    'cancel',
    'openFile',
    'reset',
    'replaceAll',
    'ready',
] as const satisfies readonly FileSearchWebviewToHostMessage['type'][];

export const FILE_SEARCH_HOST_TO_WEBVIEW_TYPES = [
    'results',
    'searching',
    'error',
    'cancelled',
    'reset',
    'replaceDone',
    'history',
] as const satisfies readonly FileSearchHostToWebviewMessage['type'][];

export const FILE_SEARCH_INBOUND_TYPES = FILE_SEARCH_WEBVIEW_TO_HOST_TYPES;
export const FILE_SEARCH_OUTBOUND_TYPES = FILE_SEARCH_HOST_TO_WEBVIEW_TYPES;
