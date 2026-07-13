import * as vscode from 'vscode';
import { HistoryStorage } from './history/historyStorage';
import { QueryHistoryEntry, QueryExecutionStatus, StorageData, SavedFilterView, HistoryFilter, QuickRerunConfig, QueryParameter } from './history/types';

// Re-export for backward compatibility
export type { QueryHistoryEntry, QueryExecutionStatus, SavedFilterView, HistoryFilter, QuickRerunConfig, QueryParameter };

export class QueryHistoryManager {
    private static readonly STORAGE_KEY = 'queryHistory';
    private static readonly SAVED_VIEWS_KEY = 'queryHistorySavedViews';
    private static readonly ACTIVE_LIMIT = 900; // Max items in memory/active file
    private static readonly BATCH_ARCHIVE_SIZE = 100; // How many items to move to archive at once when limit reached
    private static readonly SAVE_DEBOUNCE_MS = 15000; // Save to disk every 15 seconds instead of on each entry
    private static readonly MAX_SAVED_VIEWS = 20; // Maximum number of saved filter views

    private static instance: QueryHistoryManager;

    public static getInstance(context: vscode.ExtensionContext): QueryHistoryManager {
        if (!QueryHistoryManager.instance) {
            QueryHistoryManager.instance = new QueryHistoryManager(context);
        }
        return QueryHistoryManager.instance;
    }

    public static hasInstance(): boolean {
        return !!QueryHistoryManager.instance;
    }

    private cache: QueryHistoryEntry[] = [];
    private initialized = false;
    private initPromise: Promise<void> | undefined;
    private storage: HistoryStorage;
    private saveDebounceTimer: NodeJS.Timeout | undefined = undefined;
    private pendingSave = false; // Track if there's a pending save
    private flushPromise: Promise<void> | undefined;

    private _onDidAddEntry = new vscode.EventEmitter<QueryHistoryEntry>();
    public readonly onDidAddEntry = this._onDidAddEntry.event;

    constructor(private context: vscode.ExtensionContext) {
        let storagePath = '';
        if (this.context.globalStorageUri) {
            storagePath = this.context.globalStorageUri.fsPath;
        }
        this.storage = new HistoryStorage(storagePath);
        this.initialize();
    }

    private async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._initializeInternal().finally(() => {
            this.initPromise = undefined;
        });
        return this.initPromise;
    }

    private async _initializeInternal(): Promise<void> {
        if (this.initialized) return;

        try {
            // Priority 1: Load from File using Storage
            const entries = await this.storage.loadActive();

            if (entries.length > 0) {
                this.cache = entries;
            } else {
                // Priority 2: Migration from globalState (Legacy)
                // If file returns empty, check globalState
                const stored = this.context.globalState.get<StorageData>(QueryHistoryManager.STORAGE_KEY);
                if (stored && stored.entries && stored.entries.length > 0) {
                    this.cache = stored.entries;
                    console.log(`✅ Migrated ${this.cache.length} entries from globalState`);
                    await this.storage.saveActive(this.cache);
                    await this.context.globalState.update(QueryHistoryManager.STORAGE_KEY, undefined);
                } else {
                    this.cache = [];
                }
            }

            // Check if we need to migrate excess active entries to archive (Initial Cleanup)
            if (this.cache.length > QueryHistoryManager.ACTIVE_LIMIT + QueryHistoryManager.BATCH_ARCHIVE_SIZE) {
                console.log(`[QueryHistoryManager] Cache (${this.cache.length}) exceeds active limit. Migrating to archive...`);
                await this.flushToArchive();
            }

            this.initialized = true;
        } catch (error) {
            console.error('❌ Error initializing query history:', error);
            this.cache = [];
            this.initialized = true;
        }
    }

    private async flushToArchive(): Promise<void> {
        const flushThreshold = QueryHistoryManager.ACTIVE_LIMIT + QueryHistoryManager.BATCH_ARCHIVE_SIZE;

        while (true) {
            let activeFlush = this.flushPromise;
            if (!activeFlush) {
                activeFlush = this.flushToArchiveInternal();
                this.flushPromise = activeFlush;
            }

            try {
                await activeFlush;
            } finally {
                if (this.flushPromise === activeFlush) {
                    this.flushPromise = undefined;
                }
            }

            // Entries can arrive while the shared flush is awaiting disk I/O.
            // Re-run before resolving callers if that burst crossed the threshold again.
            if (this.cache.length < flushThreshold) {
                return;
            }
        }
    }

    private async flushToArchiveInternal(): Promise<void> {
        try {
            const excessCount = this.cache.length - QueryHistoryManager.ACTIVE_LIMIT;
            if (excessCount <= 0) return;

            // Identify items to move (oldest are at the end)
            const itemsToArchive = this.cache.slice(QueryHistoryManager.ACTIVE_LIMIT);
            this.cache = this.cache.slice(0, QueryHistoryManager.ACTIVE_LIMIT);

            // Persist Active immediately
            await this.storage.saveActive(this.cache);

            // Append to Archive
            await this.storage.appendToArchive(itemsToArchive);

            console.log(`[QueryHistoryManager] Archived ${itemsToArchive.length} items.`);

        } catch (error) {
            console.error('Error flushing to archive:', error);
        }
    }

    async addEntry(
        host: string,
        database: string,
        schema: string,
        query: string,
        connectionName?: string,
        tags?: string,
        description?: string,
        isUserQuery: boolean = true,
        status?: QueryExecutionStatus,
        durationMs?: number,
        rowsAffected?: number,
        errorMessage?: string,
    ): Promise<void> {
        try {
            if (!this.initialized) {
                await this.initialize();
            }

            // Skip saving system/internal queries (autocomplete, schema exploration, etc.)
            if (!isUserQuery) {
                return;
            }

            const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
            const timestamp = Date.now();

            const newEntry: QueryHistoryEntry = {
                id,
                host,
                database,
                schema,
                query: query.trim(),
                timestamp,
                connectionName,
                is_favorite: false,
                tags: tags || '',
                description: description || '',
                status,
                durationMs,
                rowsAffected,
                errorMessage,
            };

            // Add to beginning (newest first)
            this.cache.unshift(newEntry);

            // Fire event
            this._onDidAddEntry.fire(newEntry);

            // Check limit and flush if significantly over limit (batch effect)
            if (this.cache.length >= QueryHistoryManager.ACTIVE_LIMIT + QueryHistoryManager.BATCH_ARCHIVE_SIZE) {
                await this.flushToArchive();
            }

            // Schedule debounced save (every 15 seconds)
            this.scheduleDebouncedSave();
        } catch (error) {
            console.error('Error adding query to history:', error);
        }
    }

    /**
     * Schedule a save to disk with debouncing (every 15 seconds)
     */
    private scheduleDebouncedSave(): void {
        this.pendingSave = true;

        if (this.saveDebounceTimer) {
            // Timer already running, will save when it triggers
            return;
        }

        this.saveDebounceTimer = setTimeout(async () => {
            try {
                if (this.pendingSave) {
                    await this.storage.saveActive(this.cache);
                    console.log(`[QueryHistoryManager] Debounced save executed, ${this.cache.length} entries`);
                    this.pendingSave = false;
                }
            } catch (error) {
                console.error('[QueryHistoryManager] Error in debounced save:', error);
            } finally {
                this.saveDebounceTimer = undefined;
            }
        }, QueryHistoryManager.SAVE_DEBOUNCE_MS);
    }

    /**
     * Force immediate save (e.g., when extension is being disposed)
     */
    async forceSave(): Promise<void> {
        if (this.pendingSave && this.cache.length > 0) {
            await this.storage.saveActive(this.cache);
            this.pendingSave = false;
            console.log('[QueryHistoryManager] Forced save executed');
        }
    }

    async getHistory(limit?: number, offset: number = 0): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) {
            await this.initialize();
        }

        if (limit !== undefined) {
            return this.cache.slice(offset, offset + limit);
        }
        return [...this.cache];
    }

    async getAllHistory(): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) {
            await this.initialize();
        }

        try {
            const archive = await this.storage.getArchiveEntries();
            return [...this.cache, ...archive];
        } catch (error) {
            console.error('Error fetching archive history for export:', error);
            return [...this.cache];
        }
    }

    async deleteEntry(id: string): Promise<void> {
        try {
            if (!this.initialized) await this.initialize();

            const initialLen = this.cache.length;
            this.cache = this.cache.filter(entry => entry.id !== id);

            if (this.cache.length !== initialLen) {
                await this.storage.saveActive(this.cache);
            }
        } catch (error) {
            console.error('Error deleting entry:', error);
        }
    }

    async clearHistory(): Promise<void> {
        try {
            if (!this.initialized) await this.initialize();

            this.cache = [];
            await this.storage.clearAll();

            console.log('All query history cleared');
        } catch (error) {
            console.error('Error clearing history:', error);
        }
    }

    async getStats(): Promise<{
        activeEntries: number;
        archivedEntries: number;
        totalEntries: number;
        activeFileSizeMB: number;
        archiveFileSizeMB: number;
        totalFileSizeMB: number;
    }> {
        if (!this.initialized) await this.initialize();
        return this.storage.getStats(this.cache.length);
    }

    async toggleFavorite(id: string): Promise<void> {
        try {
            if (!this.initialized) await this.initialize();
            const entry = this.cache.find(e => e.id === id);
            if (entry) {
                entry.is_favorite = !entry.is_favorite;
                await this.storage.saveActive(this.cache);
            }
        } catch (error) {
            console.error('Error toggling favorite:', error);
        }
    }

    async updateEntry(id: string, tags?: string, description?: string): Promise<void> {
        try {
            if (!this.initialized) await this.initialize();
            const entry = this.cache.find(e => e.id === id);
            if (entry) {
                if (tags !== undefined) entry.tags = tags;
                if (description !== undefined) entry.description = description;
                await this.storage.saveActive(this.cache);
            }
        } catch (error) {
            console.error('Error updating entry:', error);
        }
    }

    async getFavorites(): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) await this.initialize();
        return this.cache.filter(entry => entry.is_favorite);
    }

    async getByTag(tag: string): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) await this.initialize();
        return this.cache.filter(entry => entry.tags?.toLowerCase().includes(tag.toLowerCase()));
    }

    async getAllTags(): Promise<string[]> {
        if (!this.initialized) await this.initialize();

        const allTags = new Set<string>();
        this.cache.forEach(entry => {
            if (entry.tags) {
                const tags = entry.tags.split(',');
                tags.forEach(tag => {
                    const cleanTag = tag.trim();
                    if (cleanTag) allTags.add(cleanTag);
                });
            }
        });

        return Array.from(allTags).sort();
    }

    async searchAll(searchTerm: string): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) await this.initialize();
        const term = searchTerm.toLowerCase();

        // Search Active
        const activeMatches = this.cache.filter(
            entry =>
                entry.query.toLowerCase().includes(term) ||
                entry.host.toLowerCase().includes(term) ||
                (entry.database && entry.database.toLowerCase().includes(term)) ||
                (entry.schema && entry.schema.toLowerCase().includes(term)) ||
                entry.tags?.toLowerCase().includes(term) ||
                entry.description?.toLowerCase().includes(term)
        );

        return activeMatches;
    }

    /**
     * Dedicated method to search the archive.
     * Searches without limit and includes all fields (query, host, database, schema, tags, description).
     */
    async searchArchive(searchTerm: string): Promise<QueryHistoryEntry[]> {
        try {
            const entries = await this.storage.getArchiveEntries();
            const term = searchTerm.toLowerCase();
            const matches = [];

            // Search all entries - no artificial limit
            for (const entry of entries) {
                // Full search matching searchAll() behavior
                if (
                    entry.query.toLowerCase().includes(term) ||
                    entry.host.toLowerCase().includes(term) ||
                    (entry.database && entry.database.toLowerCase().includes(term)) ||
                    (entry.schema && entry.schema.toLowerCase().includes(term)) ||
                    (entry.tags && entry.tags.toLowerCase().includes(term)) ||
                    (entry.description && entry.description.toLowerCase().includes(term))
                ) {
                    matches.push(entry);
                }
            }

            console.log(`[ArchiveSearch] Found ${matches.length} matches for "${searchTerm}"`);
            return matches;
        } catch (e) {
            console.error('Error searching archive:', e);
            return [];
        }
    }

    async getFilteredHistory(
        host?: string,
        database?: string,
        schema?: string,
        limit?: number
    ): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) await this.initialize();

        let filtered = this.cache.filter(entry => {
            if (host && entry.host !== host) return false;
            if (database && entry.database !== database) return false;
            if (schema && entry.schema !== schema) return false;
            return true;
        });

        if (limit) {
            filtered = filtered.slice(0, limit);
        }

        return filtered;
    }

    async getArchivedHistory(): Promise<QueryHistoryEntry[]> {
        // Return top 100 archived?
        // Reuse logic from historyStorage or just return [] as before if unused.
        // The original code returned [] saying "Not meant to be used".
        return [];
    }

    async clearArchive(): Promise<void> {
        await this.storage.clearArchiveOnly();
    }

    async close(): Promise<void> {
        // Force save any pending changes before closing
        await this.forceSave();
        console.log('Query history manager closed');
    }

    // ====================
    // Saved Filter Views
    // ====================

    /**
     * Get all saved filter views
     */
    async getSavedViews(): Promise<SavedFilterView[]> {
        const views = this.context.globalState.get<SavedFilterView[] | undefined>(QueryHistoryManager.SAVED_VIEWS_KEY);
        if (!views || !Array.isArray(views)) {
            return [];
        }
        return views.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Save a new filter view
     */
    async saveView(name: string, filter: HistoryFilter, description?: string): Promise<SavedFilterView | null> {
        try {
            const views = await this.getSavedViews();

            // Check if max views reached
            if (views.length >= QueryHistoryManager.MAX_SAVED_VIEWS) {
                vscode.window.showWarningMessage(`Maximum ${QueryHistoryManager.MAX_SAVED_VIEWS} saved views allowed. Please delete some views first.`);
                return null;
            }

            // Check for duplicate name
            if (views.some(v => v.name.toLowerCase() === name.toLowerCase())) {
                vscode.window.showErrorMessage(`A view with name "${name}" already exists.`);
                return null;
            }

            const newView: SavedFilterView = {
                id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                name: name.trim(),
                description: description?.trim(),
                filter,
                createdAt: Date.now()
            };

            views.push(newView);
            await this.context.globalState.update(QueryHistoryManager.SAVED_VIEWS_KEY, views);

            vscode.window.showInformationMessage(`View "${name}" saved successfully.`);
            return newView;
        } catch (error) {
            console.error('Error saving view:', error);
            vscode.window.showErrorMessage(`Failed to save view: ${error}`);
            return null;
        }
    }

    /**
     * Delete a saved filter view
     */
    async deleteView(viewId: string): Promise<boolean> {
        try {
            const views = await this.getSavedViews();
            const filtered = views.filter(v => v.id !== viewId);

            if (filtered.length === views.length) {
                return false; // View not found
            }

            await this.context.globalState.update(QueryHistoryManager.SAVED_VIEWS_KEY, filtered);
            return true;
        } catch (error) {
            console.error('Error deleting view:', error);
            return false;
        }
    }

    /**
     * Apply a saved filter view and return filtered results
     */
    async applyView(viewId: string): Promise<{ view: SavedFilterView | null; entries: QueryHistoryEntry[] }> {
        const views = await this.getSavedViews();
        const view = views.find(v => v.id === viewId);

        if (!view) {
            return { view: null, entries: [] };
        }

        const entries = await this.filterEntries(view.filter);
        return { view, entries };
    }

    /**
     * Filter entries based on filter criteria
     */
    async filterEntries(filter: HistoryFilter): Promise<QueryHistoryEntry[]> {
        if (!this.initialized) await this.initialize();

        let filtered = [...this.cache];

        // Apply search term
        if (filter.searchTerm) {
            const term = filter.caseSensitive ? filter.searchTerm : filter.searchTerm.toLowerCase();
            filtered = filtered.filter(entry => {
                const query = filter.caseSensitive ? entry.query : entry.query.toLowerCase();
                const host = filter.caseSensitive ? entry.host : entry.host.toLowerCase();
                const database = entry.database ? (filter.caseSensitive ? entry.database : entry.database.toLowerCase()) : '';
                const schema = entry.schema ? (filter.caseSensitive ? entry.schema : entry.schema.toLowerCase()) : '';
                const tags = entry.tags ? (filter.caseSensitive ? entry.tags : entry.tags.toLowerCase()) : '';
                const description = entry.description ? (filter.caseSensitive ? entry.description : entry.description.toLowerCase()) : '';

                return query.includes(term) ||
                       host.includes(term) ||
                       database.includes(term) ||
                       schema.includes(term) ||
                       tags.includes(term) ||
                       description.includes(term);
            });
        }

        // Apply tags filter
        if (filter.tags && filter.tags.length > 0) {
            filtered = filtered.filter(entry => {
                if (!entry.tags) return false;
                const entryTags = entry.tags.toLowerCase().split(',').map(t => t.trim());
                return filter.tags!.some(tag => entryTags.includes(tag.toLowerCase()));
            });
        }

        // Apply hosts filter
        if (filter.hosts && filter.hosts.length > 0) {
            filtered = filtered.filter(entry => filter.hosts!.includes(entry.host));
        }

        // Apply databases filter
        if (filter.databases && filter.databases.length > 0) {
            filtered = filtered.filter(entry => entry.database && filter.databases!.includes(entry.database));
        }

        // Apply connection names filter
        if (filter.connectionNames && filter.connectionNames.length > 0) {
            filtered = filtered.filter(entry => entry.connectionName && filter.connectionNames!.includes(entry.connectionName));
        }

        // Apply date range
        if (filter.dateFrom) {
            filtered = filtered.filter(entry => entry.timestamp >= filter.dateFrom!);
        }
        if (filter.dateTo) {
            filtered = filtered.filter(entry => entry.timestamp <= filter.dateTo!);
        }

        // Apply favorites only
        if (filter.favoritesOnly) {
            filtered = filtered.filter(entry => entry.is_favorite);
        }

        // Apply status filter
        if (filter.status) {
            filtered = filtered.filter(entry => entry.status === filter.status);
        }

        return filtered;
    }

    // ====================
    // Quick Rerun with Parameters
    // ====================

    /**
     * Parse query for parameters (e.g., :paramName, ${paramName}, {paramName}, @paramName)
     */
    parseQueryParameters(query: string): QueryParameter[] {
        const parameters: QueryParameter[] = [];
        const seen = new Set<string>();

        // Match :paramName, ${paramName}, {paramName}, @paramName, #{paramName}
        const patterns = [
            /:(\w+)/g,                // :paramName
            /\$\{(\w+)\}/g,           // ${paramName}
            /(?<!\$)\{(\w+)\}/g,      // {paramName} (not preceded by $)
            /@(\w+)/g,                // @paramName (SQL Server style)
            /#\{(\w+)\}/g             // #{paramName} (MyBatis style)
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(query)) !== null) {
                const name = match[1];
                if (!seen.has(name)) {
                    seen.add(name);
                    parameters.push({
                        name,
                        value: '',
                        type: 'string',
                        required: true
                    });
                }
            }
        }

        return parameters;
    }

    /**
     * Substitute parameters in query with values
     */
    substituteParameters(query: string, parameters: QueryParameter[]): string {
        let result = query;

        for (const param of parameters) {
            // Replace all occurrences of each parameter pattern
            const patterns = [
                new RegExp(`:${param.name}\\b`, 'g'),
                new RegExp(`\\$\\{${param.name}\\}`, 'g'),
                new RegExp(`(?<!\\$)\\{${param.name}\\}`, 'g'),  // {paramName} not preceded by $
                new RegExp(`@${param.name}\\b`, 'g'),
                new RegExp(`#\\{${param.name}\\}`, 'g')
            ];

            let value = param.value;

            // Validate and format based on parameter type
            if (param.type === 'string' && value && !/^['"].*['"]$/.test(value)) {
                value = `'${value.replace(/'/g, "''")}'`;
            } else if (param.type === 'number') {
                // Validate numeric value to prevent SQL injection
                if (!/^-?\d+(\.\d+)?$/.test(value)) {
                    throw new Error(`Invalid numeric value for parameter '${param.name}': ${value}`);
                }
            } else if (param.type === 'boolean') {
                // Normalize boolean values
                const lowerValue = value.toLowerCase();
                if (!['true', 'false', '1', '0'].includes(lowerValue)) {
                    throw new Error(`Invalid boolean value for parameter '${param.name}': ${value}`);
                }
                value = lowerValue === 'true' || lowerValue === '1' ? 'TRUE' : 'FALSE';
            }

            for (const pattern of patterns) {
                result = result.replace(pattern, value);
            }
        }

        return result;
    }

    /**
     * Save quick rerun configuration for a query
     */
    async saveQuickRerunConfig(queryId: string, config: QuickRerunConfig): Promise<void> {
        const key = `quickRerun_${queryId}`;
        await this.context.globalState.update(key, config);
    }

    /**
     * Get quick rerun configuration for a query
     */
    async getQuickRerunConfig(queryId: string): Promise<QuickRerunConfig | undefined> {
        const key = `quickRerun_${queryId}`;
        return this.context.globalState.get<QuickRerunConfig>(key);
    }
}
