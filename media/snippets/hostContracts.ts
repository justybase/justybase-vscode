/**
 * Webview-local copies of snippet message contracts.
 * Keeps `tsc --project tsconfig.media.json` from pulling src/core into the graph.
 */

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
