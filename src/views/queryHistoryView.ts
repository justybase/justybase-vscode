import * as vscode from 'vscode';
import type { QueryHistoryInboundMessage, QueryHistoryOutboundMessage, QueryHistoryUiState } from '../contracts/webviews';
import { toQueryHistoryEntryDtos, toQueryHistoryEntryDto } from '../contracts/webviews';
import { QueryHistoryManager, HistoryFilter, QueryParameter, QueryHistoryEntry } from '../core/queryHistoryManager';
import { logWithFallback } from '../utils/logger';

export class QueryHistoryView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.queryHistory';
    private _view?: vscode.WebviewView;
    private _extendedPanel?: vscode.WebviewPanel;
    private _currentOffset = 0;
    private static readonly PAGE_SIZE = 50;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Subscribe to history updates
        const historyManager = QueryHistoryManager.getInstance(this._context);
        const disposable = historyManager.onDidAddEntry(async entry => {
            const stats = await historyManager.getStats();
            const msg: QueryHistoryOutboundMessage = {
                type: 'entryAdded',
                entry: toQueryHistoryEntryDto(entry),
                stats
            };
            if (this._view) {
                this._postMessage(this._view.webview, msg);
            }
            if (this._extendedPanel) {
                this._postMessage(this._extendedPanel.webview, msg);
            }
        });
        // We really should dispose this listener when view is disposed, 
        // but webviewView.onDidDispose is not exposed here easily inside resolveWebviewView?
        // Actually it is: webviewView.onDidDispose
        webviewView.onDidDispose(() => {
            disposable.dispose();
        });

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview — the webview sends 'getHistory' on load
        // to request its initial data, so we don't need to push it preemptively.
        webviewView.webview.onDidReceiveMessage(async (data: QueryHistoryInboundMessage) => {
            switch (data.type) {
                case 'refresh':
                    this.refresh();
                    break;
                case 'loadMore':
                    await this.loadMore();
                    break;
                case 'searchArchive':
                    await this.searchArchive(data.term);
                    break;
                case 'search':
                    await this.handleSearch(data.term);
                    break;
                case 'clearAll':
                    await this.clearAllHistory();
                    break;
                case 'deleteEntry':
                    await this.deleteEntry(data.id, data.query);
                    break;
                case 'copyQuery':
                    await vscode.env.clipboard.writeText(data.query);
                    vscode.window.showInformationMessage('Query copied to clipboard');
                    break;
                case 'executeQuery':
                    await this.executeQuery(data.query);
                    break;
                case 'getHistory':
                    await this.sendHistoryToWebview(true);
                    break;
                case 'toggleFavorite':
                    await this.toggleFavorite(data.id);
                    break;
                case 'updateEntry':
                    await this.updateEntry(data.id, data.tags, data.description);
                    break;
                case 'requestEdit':
                    await this.requestEdit(data.id);
                    break;
                case 'requestTagFilter':
                    await this.requestTagFilter(data.tags);
                    break;
                case 'showFavoritesOnly':
                    await this.sendFavoritesToWebview();
                    break;
                case 'filterByTag':
                    await this.sendFilteredByTagToWebview(data.tag);
                    break;
                case 'showExtendedView':
                    await this.showExtendedView();
                    break;
                case 'exportHistory':
                    await this.exportHistory();
                    break;
                case 'getSavedViews':
                    await this.sendSavedViewsToWebview();
                    break;
                case 'saveView':
                    await this.saveView(data.name, data.filter, data.description);
                    break;
                case 'deleteView':
                    await this.deleteView(data.viewId);
                    break;
                case 'applyView':
                    await this.applyView(data.viewId);
                    break;
                case 'parseQueryParameters':
                    await this.parseQueryParameters(data.query);
                    break;
                case 'quickRerun':
                    await this.quickRerun(data.queryId, data.parameters);
                    break;
            }
        });
    }

    public refresh() {
        if (this._view) {
            this.sendHistoryToWebview(true);
        }
    }

    private async loadMore() {
        if (!this._view) return;
        this._currentOffset += QueryHistoryView.PAGE_SIZE;
        this.sendHistoryToWebview(false); // false = append
    }

    private async searchArchive(term: string) {
        if (!this._view) return;

        const webview = this._view.webview;
        this._postMessage(webview, {
            type: 'uiState',
            state: {
                kind: 'loading',
                scope: 'search',
                message: 'Searching archived query history...'
            }
        });

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const results = await historyManager.searchArchive(term);
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(results);

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'search',
                        title: 'No archived matches',
                        detail: `No archived query history matched "${term}".`,
                        stats,
                        action: { label: 'Show All', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'archiveSearchResults',
                history: sanitized,
                stats,
                term
            });
        } catch (error) {
            this.sendErrorState(webview, 'search', 'Archive search failed', error, 'getHistory');
        }
    }

    private async handleSearch(term: string) {
        if (!this._view) return;

        const webview = this._view.webview;
        this._postMessage(webview, {
            type: 'uiState',
            state: {
                kind: 'loading',
                scope: 'search',
                message: `Searching query history for "${term}"...`
            }
        });

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);

            // Search ALL active entries first
            const results = await historyManager.searchAll(term);
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(results);

            // If results < 50, also search archive and combine
            if (results.length < 50) {
                const archiveResults = await historyManager.searchArchive(term);
                const archiveSanitized = toQueryHistoryEntryDtos(archiveResults);
                // Merge archive results (avoid duplicates by id)
                const existingIds = new Set(sanitized.map(entry => entry.id));
                const newFromArchive = archiveSanitized.filter(entry => !existingIds.has(entry.id));
                sanitized.push(...newFromArchive);
            }

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'search',
                        title: 'No search results',
                        detail: `No query history matched "${term}".`,
                        stats,
                        action: { label: 'Show All', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'searchResults',
                history: sanitized,
                stats,
                term,
                source: results.length < 50 ? 'active+archive' : 'active'
            });
        } catch (error) {
            this.sendErrorState(webview, 'search', 'Search failed', error, 'getHistory');
        }
    }

    private async sendHistoryToWebview(reset: boolean = false) {
        if (!this._view) {
            return;
        }

        const webview = this._view.webview;

        if (reset) {
            this._currentOffset = 0;
        }

        if (reset) {
            this._postMessage(webview, {
                type: 'uiState',
                state: {
                    kind: 'loading',
                    scope: 'history',
                    message: 'Loading query history...'
                }
            });
        }

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const history = await historyManager.getHistory(QueryHistoryView.PAGE_SIZE, this._currentOffset);
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(history);

            logWithFallback('info', `QueryHistoryView: sending history to webview, entries=${history.length}, offset=${this._currentOffset}, reset=${reset}`);

            if (reset && sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'history',
                        title: 'No query history yet',
                        detail: 'Run a query to populate history.',
                        stats,
                        action: { label: 'Refresh', messageType: 'refresh' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'historyData',
                history: sanitized,
                stats,
                reset
            });
        } catch (error) {
            this.sendErrorState(webview, 'history', 'Unable to load query history', error, 'refresh');
        }
    }

    private async clearAllHistory() {
        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to clear all query history?',
            { modal: true },
            'Clear All'
        );

        if (confirm === 'Clear All') {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            await historyManager.clearHistory();
            this.refresh();
            vscode.window.showInformationMessage('Query history cleared');
        }
    }

    private async deleteEntry(id: string, query?: string) {
        const queryText = query ? `: ${query.substring(0, 50)}${query.length > 50 ? '...' : ''}` : '';
        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to delete this query${queryText}?`,
            { modal: true },
            'Delete'
        );

        if (answer === 'Delete') {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            await historyManager.deleteEntry(id);
            // Don't full refresh, just let UI remove it or refresh current view?
            // Simple refresh for now.
            if (this._view) {
                this._postMessage(this._view.webview, { type: 'entryDeleted', id });
            }
            // Update stats
            const stats = await historyManager.getStats();
            if (this._view) {
                this._postMessage(this._view.webview, { type: 'updateStats', stats });
            }
        }
    }

    private async executeQuery(query: string) {
        // Create a new untitled document with the query
        const doc = await vscode.workspace.openTextDocument({
            content: query,
            language: 'sql'
        });
        await vscode.window.showTextDocument(doc);
    }

    private async toggleFavorite(id: string) {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        await historyManager.toggleFavorite(id);
        // We could refresh, but better to just update UI state locally in webview if possible.
        // For now, let's keep it consistent by refreshing visible data? 
        // Or specific message 'entryUpdated'.
        this.refresh();
    }

    private async updateEntry(id: string, tags?: string, description?: string) {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        await historyManager.updateEntry(id, tags, description);
        this.refresh();
        vscode.window.showInformationMessage('Entry updated successfully');
    }

    private async requestEdit(id: string) {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        const history = await historyManager.getHistory(); // Note: this gets only active page 0 if we changed it? 
        // Wait, getHistory now has limit. calling without limit gives ALL active.
        // We will assume the user clicks on an entry that IS loaded in UI.
        // Finding it in backend might need full search if we only fetched partial?
        // Actually getHistory() without args returns cache which is ALL Active. 
        // So this is safe for Active items.
        // Archive items? They might not be in cache. 
        // But let's assume one step at a time.

        const entry = history.find(e => e.id === id);

        // If not found (maybe archived?), try searchArchive via manager is too slow...
        // For now, edit works on Active.

        if (!entry) {
            // Try to see if it was passed in the UI data? The UI has the data.
            // But we need current state.
            // Simplification: Edit only works for active history for now.
            vscode.window.showErrorMessage('Entry not found (might be archived)');
            return;
        }

        // Get tags from user
        const tags = await vscode.window.showInputBox({
            prompt: 'Enter tags (comma separated)',
            value: entry.tags || '',
            placeHolder: 'tag1, tag2, tag3'
        });

        if (tags === undefined) {
            return; // User cancelled
        }

        // Get description from user
        const description = await vscode.window.showInputBox({
            prompt: 'Enter description',
            value: entry.description || '',
            placeHolder: 'Description for this query'
        });

        if (description === undefined) {
            return; // User cancelled
        }

        await this.updateEntry(id, tags, description);
    }

    private async requestTagFilter(tags: string[]) {
        if (tags.length === 1) {
            // Only one tag, filter by it directly
            await this.sendFilteredByTagToWebview(tags[0]);
        } else if (tags.length > 1) {
            // Multiple tags, let user choose
            const selectedTag = await vscode.window.showQuickPick(tags, {
                placeHolder: 'Filter by which tag?'
            });

            if (selectedTag) {
                await this.sendFilteredByTagToWebview(selectedTag);
            }
        }
    }

    private async sendFavoritesToWebview() {
        if (!this._view) {
            return;
        }

        const webview = this._view.webview;

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const favorites = await historyManager.getFavorites();
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(favorites);

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'history',
                        title: 'No favorite queries',
                        detail: 'Mark a query with the star button to keep it in favorites.',
                        stats,
                        action: { label: 'Show All', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'historyData',
                history: sanitized,
                stats,
                filter: 'favorites',
                reset: true
            });
        } catch (error) {
            this.sendErrorState(webview, 'history', 'Unable to load favorites', error, 'getHistory');
        }
    }

    private async sendFilteredByTagToWebview(tag: string) {
        if (!this._view) {
            return;
        }

        const webview = this._view.webview;

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const entries = await historyManager.getByTag(tag);
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(entries);

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'search',
                        title: 'No tagged queries',
                        detail: `No query history is currently tagged with "${tag}".`,
                        stats,
                        action: { label: 'Show All', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'historyData',
                history: sanitized,
                stats,
                filter: `tag: ${tag}`,
                reset: true
            });
        } catch (error) {
            this.sendErrorState(webview, 'search', 'Unable to filter by tag', error, 'getHistory');
        }
    }

    private async exportHistory() {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        const allHistory = await historyManager.getAllHistory();

        if (allHistory.length === 0) {
            vscode.window.showInformationMessage('No query history to export.');
            return;
        }

        const format = await vscode.window.showQuickPick(['CSV', 'JSON'], {
            placeHolder: 'Select export format'
        });

        if (!format) return;

        const filters: { [name: string]: string[] } = format === 'CSV' ? { 'CSV Files': ['csv'] } : { 'JSON Files': ['json'] };
        const uri = await vscode.window.showSaveDialog({
            filters,
            saveLabel: `Export to ${format}`
        });

        if (!uri) return;

        try {
            if (format === 'JSON') {
                const fs = await import('fs/promises');
                await fs.writeFile(uri.fsPath, JSON.stringify(allHistory, null, 2), 'utf-8');
            } else if (format === 'CSV') {
                const csvRows = [];
                // headers
                csvRows.push(['id', 'timestamp', 'host', 'database', 'schema', 'is_favorite', 'tags', 'description', 'status', 'duration_ms', 'rows_affected', 'error_message', 'query'].join(','));

                for (const entry of allHistory) {
                    const cleanTags = (entry.tags || '').replace(/"/g, '""');
                    const cleanDesc = (entry.description || '').replace(/"/g, '""');
                    const cleanQuery = entry.query.replace(/"/g, '""');
                    const cleanError = (entry.errorMessage || '').replace(/"/g, '""');

                    const row = [
                        entry.id,
                        new Date(entry.timestamp).toISOString(),
                        entry.host,
                        entry.database || '',
                        entry.schema || '',
                        entry.is_favorite ? 'true' : 'false',
                        `"${cleanTags}"`,
                        `"${cleanDesc}"`,
                        entry.status || '',
                        entry.durationMs !== undefined ? String(entry.durationMs) : '',
                        entry.rowsAffected !== undefined ? String(entry.rowsAffected) : '',
                        `"${cleanError}"`,
                        `"${cleanQuery}"`
                    ];
                    csvRows.push(row.join(','));
                }
                const fs = await import('fs/promises');
                await fs.writeFile(uri.fsPath, csvRows.join('\n'), 'utf-8');
            }

            vscode.window.showInformationMessage(`Query history exported successfully to ${uri.fsPath}`);
        } catch (error) {
            logWithFallback('error', 'Error exporting history:', error);
            vscode.window.showErrorMessage(`Failed to export history: ${error}`);
        }
    }

    private async showExtendedView() {
        // Dispose previous panel if exists
        if (this._extendedPanel) {
            this._extendedPanel.dispose();
        }

        // Create a new webview panel for extended view
        const panel = vscode.window.createWebviewPanel(
            'netezza.queryHistoryExtended',
            'Query History - Extended View',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );
        this._extendedPanel = panel;

        panel.onDidDispose(() => {
            if (this._extendedPanel === panel) {
                this._extendedPanel = undefined;
            }
        });

        // Get URIs for external resources
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'queryHistoryExtended.css'));
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'queryHistoryExtended.js'));
        const tanstackTableUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-table-core.js'));
        const tanstackVirtualUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-virtual-core.js'));

        panel.webview.html = this._getExtendedViewHtml(panel.webview, styleUri, scriptUri, tanstackTableUri, tanstackVirtualUri);

        // Handle messages from the extended view
        panel.webview.onDidReceiveMessage(async (data: QueryHistoryInboundMessage) => {
            switch (data.type) {
                case 'refresh':
                case 'getHistory':
                    await this.sendHistoryToExtendedView(panel);
                    break;
                case 'search':
                    await this.handleExtendedSearch(panel, data.term);
                    break;
                case 'filterByStatus':
                    await this.handleExtendedStatusFilter(panel, data.status);
                    break;
                case 'executeQuery':
                    await this.executeQuery(data.query);
                    break;
                case 'copyQuery':
                    await vscode.env.clipboard.writeText(data.query);
                    vscode.window.showInformationMessage('Query copied to clipboard');
                    break;
                case 'deleteEntry':
                    await this.deleteEntry(data.id, data.query);
                    break;
                case 'toggleFavorite':
                    await this.toggleFavorite(data.id);
                    break;
                case 'parseQueryParameters':
                    await this.sendQueryParameters(panel.webview, data.query);
                    break;
                case 'quickRerun':
                    await this.quickRerun(data.queryId, data.parameters);
                    break;
            }
        });

        // Send initial history to extended view
        await this.sendHistoryToExtendedView(panel);
    }

    private async sendHistoryToExtendedView(panel: vscode.WebviewPanel) {
        const webview = panel.webview;
        this._postMessage(webview, {
            type: 'uiState',
            state: {
                kind: 'loading',
                scope: 'history',
                message: 'Loading query history...'
            }
        });

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const history = await historyManager.getHistory();
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(history);

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'history',
                        title: 'No query history yet',
                        detail: 'Run a query to populate history.',
                        stats,
                        action: { label: 'Refresh', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'historyData',
                history: sanitized,
                stats
            });
        } catch (error) {
            this.sendErrorState(webview, 'history', 'Unable to load query history', error, 'getHistory');
        }
    }

    private async handleExtendedStatusFilter(panel: vscode.WebviewPanel, status: 'success' | 'error' | 'cancelled' | 'all') {
        const webview = panel.webview;
        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            let history: QueryHistoryEntry[];
            if (status === 'all') {
                history = await historyManager.getHistory();
            } else {
                const all = await historyManager.getHistory();
                history = all.filter(e => e.status === status);
            }
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(history);
            this._postMessage(webview, {
                type: 'historyData',
                history: sanitized,
                stats,
                filter: status === 'all' ? undefined : `Status: ${status}`
            });
        } catch (error) {
            this.sendErrorState(webview, 'history', 'Unable to filter by status', error, 'getHistory');
        }
    }

    private async handleExtendedSearch(panel: vscode.WebviewPanel, term: string) {
        const webview = panel.webview;
        this._postMessage(webview, {
            type: 'uiState',
            state: {
                kind: 'loading',
                scope: 'search',
                message: `Searching query history for "${term}"...`
            }
        });

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);

            const results = await historyManager.searchAll(term);
            const stats = await historyManager.getStats();
            const sanitized = toQueryHistoryEntryDtos(results);

            if (results.length < 50) {
                const archiveResults = await historyManager.searchArchive(term);
                const archiveSanitized = toQueryHistoryEntryDtos(archiveResults);
                const existingIds = new Set(sanitized.map(entry => entry.id));
                const newFromArchive = archiveSanitized.filter(entry => !existingIds.has(entry.id));
                sanitized.push(...newFromArchive);
            }

            if (sanitized.length === 0) {
                this._postMessage(webview, {
                    type: 'uiState',
                    state: {
                        kind: 'empty',
                        scope: 'search',
                        title: 'No search results',
                        detail: `No query history matched "${term}".`,
                        stats,
                        action: { label: 'Show All', messageType: 'getHistory' }
                    }
                });
                return;
            }

            this._postMessage(webview, {
                type: 'searchResults',
                history: sanitized,
                stats,
                term,
                source: results.length < 50 ? 'active+archive' : 'active'
            });
        } catch (error) {
            this.sendErrorState(webview, 'search', 'Search failed', error, 'getHistory');
        }
    }

    private _getExtendedViewHtml(webview: vscode.Webview, styleUri: vscode.Uri, scriptUri: vscode.Uri, tanstackTableUri: vscode.Uri, tanstackVirtualUri: vscode.Uri): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Query History - Extended View</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div class="extended-container">
        <div class="toolbar">
            <div class="toolbar-left">
                <input type="search" id="searchInput" placeholder="Search queries..." />
                <select id="statusFilter" class="status-filter">
                    <option value="all">All Status</option>
                    <option value="success">✅ Success</option>
                    <option value="error">❌ Error</option>
                    <option value="cancelled">⚠️ Cancelled</option>
                </select>
                <span class="stats" id="stats">Loading...</span>
            </div>
            <div class="toolbar-right">
                <button id="refreshBtn">↻ Refresh</button>
            </div>
        </div>
        <div class="main-content">
            <div class="entries-list" id="entriesList">
                <div class="list-header">
                    <h3>History Entries</h3>
                </div>
                <div id="entriesContainer" class="entries-container"></div>
            </div>
            <div class="resize-divider" id="resizeDivider"></div>
            <div class="entry-details">
                <div class="details-header">
                    <h3>Entry Details</h3>
                    <div class="details-actions">
                        <button id="copyQueryBtn" disabled>📋 Copy</button>
                        <button id="executeQueryBtn" disabled>▶️ Run</button>
                        <button id="quickRerunBtn" disabled>🔧 Quick Run</button>
                        <button id="deleteEntryBtn" disabled>🗑️ Delete</button>
                        <button id="toggleFavoriteBtn" disabled>☆ Favorite</button>
                    </div>
                </div>
                <div id="detailsContent" class="details-content">
                    <div class="empty-details">
                        <div class="empty-details-icon">📋</div>
                        <div>Select an entry to view details</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script src="${tanstackTableUri}"></script>
    <script src="${tanstackVirtualUri}"></script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Get URIs for external resources
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'queryHistory.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'queryHistory.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Query History</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-top">
            <input type="search" id="searchInput" placeholder="Search queries..." />
            <span class="stats" id="stats">Loading...</span>
        </div>
        <div class="toolbar-buttons">
            <button class="secondary" id="showAllBtn">📜 All</button>
            <button class="secondary" id="showFavoritesBtn">⭐ Favorites</button>
            <button class="secondary" id="showExtendedViewBtn">🔍 Extended View</button>
            <button class="secondary" id="exportBtn">📥 Export</button>
            <button class="secondary" id="refreshBtn">↻ Refresh</button>
            <button class="secondary" id="clearAllBtn">🗑️ Clear All</button>
        </div>
    </div>
    <div class="history-container" id="historyContainer">
        <div class="empty-state">
            <div class="empty-state-icon">📜</div>
            <div>No query history yet</div>
        </div>
    </div>
    <div id="loadingIndicator" class="loading-indicator" style="display:none;">Loading more...</div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    // ====================
    // Saved Filter Views
    // ====================

    private async sendSavedViewsToWebview(): Promise<void> {
        if (!this._view) return;

        const webview = this._view.webview;

        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const views = await historyManager.getSavedViews();

            this._postMessage(webview, {
                type: 'savedViewsData',
                views
            });
        } catch (error) {
            this.sendErrorState(webview, 'savedViews', 'Unable to load saved views', error, 'getSavedViews');
        }
    }

    private async saveView(name: string, filter: HistoryFilter, description?: string): Promise<void> {
        if (!this._view) return;

        const historyManager = QueryHistoryManager.getInstance(this._context);
        const view = await historyManager.saveView(name, filter, description);

        if (view) {
            this._postMessage(this._view.webview, {
                type: 'viewSaved',
                view
            });
            // Refresh the saved views list
            await this.sendSavedViewsToWebview();
        }
    }

    private async deleteView(viewId: string): Promise<void> {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        const success = await historyManager.deleteView(viewId);

        if (success && this._view) {
            this._postMessage(this._view.webview, {
                type: 'viewDeleted',
                viewId
            });
            await this.sendSavedViewsToWebview();
        }
    }

    private async applyView(viewId: string): Promise<void> {
        if (!this._view) return;

        const historyManager = QueryHistoryManager.getInstance(this._context);
        const { view, entries } = await historyManager.applyView(viewId);

        if (view) {
            const sanitized = toQueryHistoryEntryDtos(entries);
            const stats = await historyManager.getStats();

            this._postMessage(this._view.webview, {
                type: 'historyData',
                history: sanitized,
                stats,
                filter: view.name,
                reset: true
            });
        }
    }

    // ====================
    // Quick Rerun with Parameters
    // ====================

    private async parseQueryParameters(query: string): Promise<void> {
        if (!this._view) return;
        await this.sendQueryParameters(this._view.webview, query);
    }

    private _postMessage(webview: vscode.Webview, message: QueryHistoryOutboundMessage): void {
        void webview.postMessage(message);
    }

    private async sendQueryParameters(webview: vscode.Webview, query: string): Promise<void> {
        try {
            const historyManager = QueryHistoryManager.getInstance(this._context);
            const parameters = historyManager.parseQueryParameters(query);

            this._postMessage(webview, {
                type: 'queryParameters',
                parameters
            });
        } catch (error) {
            this.sendErrorState(webview, 'quickRerun', 'Unable to parse query parameters', error, 'getHistory');
        }
    }

    private sendErrorState(
        webview: vscode.Webview,
        scope: QueryHistoryUiState['scope'],
        title: string,
        error: unknown,
        actionType: 'refresh' | 'getHistory' | 'getSavedViews'
    ): void {
        this._postMessage(webview, {
            type: 'uiState',
            state: {
                kind: 'error',
                scope,
                title,
                detail: this.toErrorDetail(error),
                action: {
                    label: actionType === 'getSavedViews' ? 'Reload Saved Views' : 'Retry',
                    messageType: actionType
                }
            }
        });
    }

    private toErrorDetail(error: unknown): string {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        return String(error);
    }

    private async quickRerun(queryId: string, parameters: QueryParameter[]): Promise<void> {
        const historyManager = QueryHistoryManager.getInstance(this._context);
        const history = await historyManager.getHistory();
        const entry = history.find(e => e.id === queryId);

        if (!entry) {
            vscode.window.showErrorMessage('Query not found');
            return;
        }

        // Substitute parameters in the query
        const finalQuery = historyManager.substituteParameters(entry.query, parameters);

        // Open the query in editor
        const doc = await vscode.workspace.openTextDocument({
            content: finalQuery,
            language: 'sql'
        });
        await vscode.window.showTextDocument(doc);

        // Save the quick rerun config for future use
        await historyManager.saveQuickRerunConfig(queryId, {
            originalQuery: entry.query,
            parameters: parameters,
            timestamp: Date.now()
        });

        vscode.window.showInformationMessage('Query opened with parameters substituted. Press F5 to execute.');
    }
}
