import type { SchemaFavorite } from '../../core/favoritesManager';

export interface SnippetDto {
    id: string;
    name: string;
    tags: string;
    sql: string;
    updatedAt: number;
}

export type SnippetsWebviewToHostMessage =
    | { type: 'getSnippets' }
    | { type: 'getCurrentSql' }
    | { type: 'saveSnippet'; id?: string; name: string; tags: string; sql: string }
    | { type: 'deleteSnippet'; id: string; name: string }
    | { type: 'insertSnippet'; sql: string }
    | { type: 'runSnippet'; sql: string; name: string };

export type SnippetsHostToWebviewMessage =
    | { type: 'snippetsData'; snippets: SnippetDto[]; currentSql: string }
    | { type: 'currentSql'; sql: string }
    | { type: 'openForm'; sql: string; snippet?: SnippetDto }
    | { type: 'snippetSaved'; id: string; name: string }
    | { type: 'snippetDeleted'; id: string; name: string }
    | { type: 'snippetsError'; message: string };

export type SnippetsInboundMessage = SnippetsWebviewToHostMessage;
export type SnippetsOutboundMessage = SnippetsHostToWebviewMessage;

export const SNIPPETS_WEBVIEW_TO_HOST_TYPES = [
    'getSnippets',
    'getCurrentSql',
    'saveSnippet',
    'deleteSnippet',
    'insertSnippet',
    'runSnippet'
] as const satisfies readonly SnippetsWebviewToHostMessage['type'][];

export const SNIPPETS_HOST_TO_WEBVIEW_TYPES = [
    'snippetsData',
    'currentSql',
    'openForm',
    'snippetSaved',
    'snippetDeleted',
    'snippetsError'
] as const satisfies readonly SnippetsHostToWebviewMessage['type'][];

export const SNIPPETS_INBOUND_TYPES = SNIPPETS_WEBVIEW_TO_HOST_TYPES;
export const SNIPPETS_OUTBOUND_TYPES = SNIPPETS_HOST_TO_WEBVIEW_TYPES;

export function toSnippetDto(favorite: SchemaFavorite): SnippetDto {
    return {
        id: favorite.id,
        name: favorite.label,
        tags: favorite.tags ?? '',
        sql: favorite.sqlContent ?? '',
        updatedAt: favorite.timestamp
    };
}
