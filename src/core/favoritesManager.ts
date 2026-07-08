import * as vscode from 'vscode';
import { SchemaItem } from '../providers/schemaProvider';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { unquoteIdentifier } from '../utils/identifierUtils';
import {
    compatibilityFiles,
    compatibilityStateKeys,
    getMementoValue,
    updateMementoValue
} from '../compatibility/state';

export interface SchemaFavorite {
    id: string; // Unique identifier (UUID or migrated old id)
    type: 'object' | 'folder' | 'sql';
    label: string;
    // for 'object'
    connectionName?: string;
    dbName?: string;
    schema?: string;
    objType?: string;
    // for 'sql'
    sqlContent?: string;
    // general
    parentId?: string; // ID of parent folder (undefined = root)
    customNote?: string;
    timestamp: number;
    owner?: string;
    description?: string;
    // Copilot integration fields (for 'object' type with objType TABLE/VIEW)
    autoInclude?: boolean; // Auto-include in Copilot context
    enabled?: boolean; // Enabled for Copilot context
}

interface FavoritesRepositoryFile {
    version: number;
    favorites: SchemaFavorite[];
}

export class FavoritesManager {
    private static readonly STORAGE_KEY = 'schemaFavorites';
    private static readonly REPOSITORY_FILE_VERSION = 1;
    private static instance: FavoritesManager;

    public static getInstance(context: vscode.ExtensionContext): FavoritesManager {
        if (!FavoritesManager.instance) {
            FavoritesManager.instance = new FavoritesManager(context);
        }
        return FavoritesManager.instance;
    }

    private cache: SchemaFavorite[] = [];
    private initialized = false;
    private mirrorLegacyRepositoryFile = false;

    private _onDidChangeFavorites = new vscode.EventEmitter<void>();
    public readonly onDidChangeFavorites = this._onDidChangeFavorites.event;

    private constructor(private context: vscode.ExtensionContext) {
        this.initialize();
    }

    private normalizeObjectLabel(label: string): string {
        return unquoteIdentifier(label);
    }

    private getRepositorySyncPath(useLegacyPath: boolean = false): string | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }
        const relativePath = useLegacyPath
            ? compatibilityFiles.favoritesRepository.legacy
            : compatibilityFiles.favoritesRepository.current;
        return path.join(workspaceFolder.uri.fsPath, relativePath);
    }

    private loadFavoritesFromRepository(): SchemaFavorite[] | undefined {
        const repositoryPaths = [
            { filePath: this.getRepositorySyncPath(false), isLegacy: false },
            { filePath: this.getRepositorySyncPath(true), isLegacy: true }
        ];

        for (const entry of repositoryPaths) {
            const { filePath, isLegacy } = entry;
            if (!filePath || !fs.existsSync(filePath)) {
                continue;
            }

            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const parsed = JSON.parse(raw) as unknown;

                if (Array.isArray(parsed)) {
                    this.mirrorLegacyRepositoryFile = isLegacy;
                    return parsed as SchemaFavorite[];
                }

                if (parsed && typeof parsed === 'object') {
                    const data = parsed as Partial<FavoritesRepositoryFile>;
                    if (Array.isArray(data.favorites)) {
                        this.mirrorLegacyRepositoryFile = isLegacy;
                        return data.favorites;
                    }
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[FavoritesManager] Failed to load repository favorites sync file:', error);
                void vscode.window.showWarningMessage(
                    `Failed to load favorites from workspace file: ${message}. Using local favorites instead.`
                );
                return undefined;
            }
        }

        return undefined;
    }

    private writeFavoritesToRepositoryFile(filePath: string): void {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const payload: FavoritesRepositoryFile = {
            version: FavoritesManager.REPOSITORY_FILE_VERSION,
            favorites: this.cache
        };
        const content = `${JSON.stringify(payload, null, 2)}\n`;

        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, content, 'utf-8');
        fs.renameSync(tempPath, filePath);
    }

    private saveFavoritesToRepository(): void {
        const filePath = this.getRepositorySyncPath();
        if (!filePath) {
            return;
        }

        try {
            this.writeFavoritesToRepositoryFile(filePath);

            const legacyFilePath = this.getRepositorySyncPath(true);
            if (legacyFilePath && (this.mirrorLegacyRepositoryFile || fs.existsSync(legacyFilePath))) {
                this.mirrorLegacyRepositoryFile = true;
                this.writeFavoritesToRepositoryFile(legacyFilePath);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[FavoritesManager] Failed to save repository favorites sync file:', error);
            // Show warning to user for critical failures
            void vscode.window.showWarningMessage(
                `Failed to sync favorites to workspace file: ${message}. Changes will be stored locally only.`
            );
        }
    }

    private initialize(): void {
        if (this.initialized) return;

        try {
            const stored = this.context.globalState.get<unknown>(FavoritesManager.STORAGE_KEY);
            const repositoryFavorites = this.loadFavoritesFromRepository();

            if (repositoryFavorites) {
                this.cache = this.migrateOldFavorites(repositoryFavorites);
                void this.context.globalState
                    .update(FavoritesManager.STORAGE_KEY, this.cache)
                    .then(undefined, (error: unknown) => {
                        console.error('[FavoritesManager] Failed to persist repository-synced favorites to global storage:', error);
                    });
                this.initialized = true;
                return;
            }

            if (Array.isArray(stored)) {
                this.cache = this.migrateOldFavorites(stored);
            } else {
                this.cache = [];
            }
            this.saveFavoritesToRepository();
            this.initialized = true;
        } catch (error: unknown) {
            console.error('[FavoritesManager] Error initializing favorites:', error);
            this.cache = [];
            this.initialized = true;
        }
    }

    private migrateOldFavorites(stored: unknown[]): SchemaFavorite[] {
        let needsSave = false;
        const migrated = stored
            .map(item => {
                if (!item || typeof item !== 'object') {
                    needsSave = true;
                    return undefined;
                }
                const migratedItem: Partial<SchemaFavorite> = { ...(item as Partial<SchemaFavorite>) };

                if (migratedItem.type !== 'object' && migratedItem.type !== 'folder' && migratedItem.type !== 'sql') {
                    needsSave = true;
                    migratedItem.type = 'object';
                    migratedItem.parentId = undefined;
                }

                if (!migratedItem.id || typeof migratedItem.id !== 'string') {
                    needsSave = true;
                    migratedItem.id = FavoritesManager.generateId({});
                }

                if (typeof migratedItem.timestamp !== 'number' || Number.isNaN(migratedItem.timestamp)) {
                    needsSave = true;
                    migratedItem.timestamp = Date.now();
                }

                if (typeof migratedItem.label !== 'string') {
                    needsSave = true;
                    migratedItem.label = '';
                }

                if (migratedItem.type === 'object' && typeof migratedItem.label === 'string') {
                    const normalizedLabel = this.normalizeObjectLabel(migratedItem.label);
                    if (normalizedLabel !== migratedItem.label) {
                        migratedItem.label = normalizedLabel;
                        needsSave = true;
                    }
                }

                return migratedItem as SchemaFavorite;
            })
            .filter((item): item is SchemaFavorite => item !== undefined);

        if (needsSave) {
            // update in background
            void this.context.globalState
                .update(FavoritesManager.STORAGE_KEY, migrated)
                .then(undefined, (error: unknown) => {
                    console.error('[FavoritesManager] Failed to persist migrated favorites:', error);
                });
        }
        return migrated;
    }

    public static generateId(item: SchemaItem | SchemaFavorite | { id?: string }): string {
        if ('id' in item && typeof item.id === 'string' && item.id) return item.id;
        try {
            return crypto.randomUUID();
        } catch {
            return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        }
    }

    public async getFavorites(): Promise<SchemaFavorite[]> {
        if (!this.initialized) this.initialize();
        return [...this.cache];
    }

    public async getFavoritesByParent(parentId?: string): Promise<SchemaFavorite[]> {
        if (!this.initialized) this.initialize();
        const items = this.cache.filter(f => f.parentId === parentId);

        // Let's sort folders first, then alphabetically
        return items.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.label.localeCompare(b.label);
        });
    }

    public getFavoriteById(id: string): SchemaFavorite | undefined {
        if (!this.initialized) this.initialize();
        return this.cache.find(f => f.id === id);
    }

    public isFavorite(item: SchemaItem): boolean {
        if (!this.initialized) this.initialize();
        const objectLabel = this.normalizeObjectLabel(item.rawLabel || item.label);
        // Since we don't know the exact UUID of an item just from a SchemaItem,
        // we check by old logical identity for backwards compatibility when checking if an object is favorited.
        return this.cache.some(f =>
            f.type === 'object' &&
            f.connectionName === item.connectionName &&
            f.dbName === item.dbName &&
            f.schema === item.schema &&
            f.objType === item.objType &&
            f.label === objectLabel
        );
    }

    public getFavoriteByLogicalIdentity(item: SchemaItem): SchemaFavorite | undefined {
        if (!this.initialized) this.initialize();
        const objectLabel = this.normalizeObjectLabel(item.rawLabel || item.label);
        return this.cache.find(f =>
            f.type === 'object' &&
            f.connectionName === item.connectionName &&
            f.dbName === item.dbName &&
            f.schema === item.schema &&
            f.objType === item.objType &&
            f.label === objectLabel
        );
    }

    // Existing toggleFavorite will still work but it adds to the root.
    public async toggleFavorite(item: SchemaItem): Promise<boolean> {
        if (!this.initialized) this.initialize();

        const existing = this.getFavoriteByLogicalIdentity(item);
        const isNowFavorite = !existing;

        if (isNowFavorite) {
            const objectLabel = this.normalizeObjectLabel(item.rawLabel || item.label);
            const favorite: SchemaFavorite = {
                id: FavoritesManager.generateId({}), // generate new UUID
                type: 'object',
                connectionName: item.connectionName || '',
                dbName: item.dbName || '',
                schema: item.schema,
                objType: item.objType,
                label: objectLabel,
                timestamp: Date.now(),
                owner: item.owner,
                description: item.objectDescription,
                parentId: undefined
            };
            this.cache.push(favorite);
        } else {
            this.cache = this.cache.filter(f => f.id !== existing.id);
        }

        await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
        this.saveFavoritesToRepository();
        this._onDidChangeFavorites.fire();

        return isNowFavorite;
    }

    public async addFolder(name: string, parentId?: string): Promise<string> {
        if (!this.initialized) this.initialize();
        const id = crypto.randomUUID();
        const folder: SchemaFavorite = {
            id,
            type: 'folder',
            label: name,
            timestamp: Date.now(),
            parentId
        };
        this.cache.push(folder);
        await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
        this.saveFavoritesToRepository();
        this._onDidChangeFavorites.fire();
        return id;
    }

    public async addSqlSnippet(label: string, sqlContent: string, parentId?: string): Promise<string> {
        if (!this.initialized) this.initialize();
        const id = crypto.randomUUID();
        // create parent "Queries" folder if not specified and not exists? Let's keep it simple and just drop where requested.
        const snippet: SchemaFavorite = {
            id,
            type: 'sql',
            label,
            sqlContent,
            autoInclude: false,
            timestamp: Date.now(),
            parentId
        };
        this.cache.push(snippet);
        await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
        this.saveFavoritesToRepository();
        this._onDidChangeFavorites.fire();
        return id;
    }

    public async updateNote(id: string, note?: string): Promise<void> {
        if (!this.initialized) this.initialize();
        const index = this.cache.findIndex(f => f.id === id);
        if (index > -1) {
            this.cache[index].customNote = note;
            await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
            this.saveFavoritesToRepository();
            this._onDidChangeFavorites.fire();
        }
    }

    public async moveItem(id: string, newParentId?: string): Promise<void> {
        if (!this.initialized) this.initialize();
        const index = this.cache.findIndex(f => f.id === id);
        if (index > -1 && id !== newParentId) {
            this.cache[index].parentId = newParentId;
            await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
            this.saveFavoritesToRepository();
            this._onDidChangeFavorites.fire();
        }
    }

    public async removeFavoriteById(id: string): Promise<void> {
        if (!this.initialized) this.initialize();

        // collect item and all descendants
        const toDelete = new Set<string>();
        const queue = [id];

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            toDelete.add(currentId);

            const children = this.cache.filter(f => f.parentId === currentId).map(f => f.id);
            queue.push(...children);
        }

        const initialLen = this.cache.length;
        this.cache = this.cache.filter(f => !toDelete.has(f.id));

        if (this.cache.length !== initialLen) {
            await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
            this.saveFavoritesToRepository();
            this._onDidChangeFavorites.fire();
        }
    }

    public async clearAll(): Promise<void> {
        if (!this.initialized) this.initialize();
        this.cache = [];
        await this.context.globalState.update(FavoritesManager.STORAGE_KEY, undefined);
        this.saveFavoritesToRepository();
        this._onDidChangeFavorites.fire();
    }

    // ========== Copilot Integration Methods ==========

    /**
     * Get all table/view favorites that can be used for Copilot context
     */
    public async getTableProfilesForCopilot(): Promise<SchemaFavorite[]> {
        if (!this.initialized) this.initialize();
        return this.cache.filter(f =>
            f.type === 'object' &&
            (f.objType === 'TABLE' || f.objType === 'VIEW' || f.objType === 'EXTERNAL TABLE')
        );
    }

    /**
     * Get all SQL query favorites that can be used for Copilot context
     */
    public async getSqlProfilesForCopilot(): Promise<SchemaFavorite[]> {
        if (!this.initialized) this.initialize();
        return this.cache.filter(f => f.type === 'sql');
    }

    /**
     * Get favorites that should be included in Copilot context
     * (enabled and autoInclude, or manually included via includeNow)
     */
    public async getProfilesForCopilotContext(): Promise<SchemaFavorite[]> {
        if (!this.initialized) this.initialize();
        const includeOnceIds = this.getManualIncludeIds();
        const profiles = this.cache.filter(f =>
            (
                (f.type === 'object' && (f.objType === 'TABLE' || f.objType === 'VIEW' || f.objType === 'EXTERNAL TABLE')) ||
                (f.type === 'sql')
            ) &&
            f.enabled !== false && // default true
            ((f.type === 'sql' ? f.autoInclude === true : f.autoInclude !== false) || includeOnceIds.has(f.id)) // autoInclude or manual
        );

        // Clear manual includes after consumption
        await this.clearManualInclude();
        return profiles;
    }

    /**
     * Set Copilot settings for a favorite
     */
    public async setCopilotSettings(id: string, settings: { autoInclude?: boolean; enabled?: boolean }): Promise<SchemaFavorite | undefined> {
        if (!this.initialized) this.initialize();
        const index = this.cache.findIndex(f => f.id === id);
        if (index === -1) return undefined;

        if (settings.autoInclude !== undefined) {
            this.cache[index].autoInclude = settings.autoInclude;
        }
        if (settings.enabled !== undefined) {
            this.cache[index].enabled = settings.enabled;
        }

        await this.context.globalState.update(FavoritesManager.STORAGE_KEY, this.cache);
        this.saveFavoritesToRepository();
        this._onDidChangeFavorites.fire();
        return this.cache[index];
    }

    /**
     * Include a favorite in the next Copilot prompt (one-time)
     */
    public async includeNow(id: string): Promise<boolean> {
        if (!this.initialized) this.initialize();
        const exists = this.cache.some(f => f.id === id);
        if (!exists) return false;

        const includeOnceIds = this.getManualIncludeIds();
        includeOnceIds.add(id);
        await this.saveManualIncludeIds(includeOnceIds);
        return true;
    }

    /**
     * Format favorites for Copilot tool output
     */
    public async formatProfilesForToolOutput(mode: 'full' | 'summary' | 'content' = 'summary', profileNames?: string[]): Promise<string> {
        let profiles = await this.getTableProfilesForCopilot();
        let sqlProfiles = await this.getSqlProfilesForCopilot();

        // Apply filtering if in 'content' mode and names are provided
        if (mode === 'content' && profileNames && profileNames.length > 0) {
            const normalizedNames = profileNames.map(n => n.toLowerCase());

            profiles = profiles.filter(p => {
                const fullName = `${p.dbName}.${p.schema}.${p.label}`.toLowerCase();
                return normalizedNames.some(name =>
                    fullName.includes(name) || p.label.toLowerCase().includes(name) || p.id.toLowerCase() === name
                );
            });

            sqlProfiles = sqlProfiles.filter(p => {
                return normalizedNames.some(name =>
                    p.label.toLowerCase().includes(name) || p.id.toLowerCase() === name
                );
            });
        }

        if (profiles.length === 0 && sqlProfiles.length === 0) {
            return 'No favorite tables or SQL queries configured for Copilot context (or none matched requested names).';
        }

        // Calculate total SQL content length for 'summary' mode auto-inclusion
        let totalSqlLength = 0;
        for (const profile of sqlProfiles) {
            if (profile.sqlContent) {
                totalSqlLength += profile.sqlContent.length;
            }
        }

        // If content is very small, we can just switch to 'full' mode implicitly
        const MAX_AUTO_INCLUDE_LENGTH = 3000;
        const effectiveMode = (mode === 'summary' && totalSqlLength < MAX_AUTO_INCLUDE_LENGTH) ? 'full' : mode;

        const manualIds = this.getManualIncludeIds();
        const lines: string[] = ['# Favorite Tables and SQL for Copilot Context', ''];

        if (effectiveMode === 'summary' && totalSqlLength >= MAX_AUTO_INCLUDE_LENGTH) {
            lines.push(`> [!NOTE]`);
            lines.push(`> SQL Snippet content is omitted in 'summary' mode because total length (${totalSqlLength} chars) exceeds auto-include limit.`);
            lines.push(`> To fetch full snippet code, call this tool again with \`mode: 'content'\` and pass specific snippet \`profileNames\`.`);
            lines.push('');
        }

        for (const profile of profiles) {
            const fullName = `${profile.dbName}.${profile.schema}.${profile.label}`;
            const modes: string[] = [];
            if (profile.enabled !== false) {
                if (profile.autoInclude !== false) {
                    modes.push('auto');
                }
                if (manualIds.has(profile.id)) {
                    modes.push('manual-next');
                }
            } else {
                modes.push('disabled');
            }
            const modeText = modes.length > 0 ? modes.join(', ') : 'manual-only';
            lines.push(`- ${fullName} [${modeText}]`);
            if (profile.customNote && profile.customNote.trim().length > 0) {
                lines.push(`  notes: ${profile.customNote.trim()}`);
            }
        }

        for (const profile of sqlProfiles) {
            const fullName = `SQL: ${profile.label}`;
            const modes: string[] = [];
            const sqlAutoInclude = profile.autoInclude === true;
            if (profile.enabled !== false) {
                if (sqlAutoInclude) {
                    modes.push('auto');
                }
                if (manualIds.has(profile.id)) {
                    modes.push('manual-next');
                }
            } else {
                modes.push('disabled');
            }
            const modeText = modes.length > 0 ? modes.join(', ') : 'manual-only';
            lines.push(`- ${fullName} [${modeText}]`);
            if (profile.customNote && profile.customNote.trim().length > 0) {
                lines.push(`  notes: ${profile.customNote.trim()}`);
            }
            if (effectiveMode === 'full' || effectiveMode === 'content') {
                if (profile.sqlContent && profile.sqlContent.trim().length > 0) {
                    lines.push(`  content:\n\`\`\`sql\n${profile.sqlContent.trim()}\n\`\`\``);
                }
            } else if (profile.sqlContent && profile.sqlContent.trim().length > 0) {
                lines.push(`  [Content omitted for brevity. Length: ${profile.sqlContent.length} chars. Use 'content' mode with this snippet's name to fetch.]`);
            }
        }
        return lines.join('\n');
    }

    // Manual include tracking (stored in workspaceState for session)
    private getManualIncludeIds(): Set<string> {
        const ids = getMementoValue<string[]>(
            this.context.workspaceState,
            compatibilityStateKeys.favoritesIncludeOnce
        );
        return new Set(ids && Array.isArray(ids) ? ids : []);
    }

    private async saveManualIncludeIds(ids: Set<string>): Promise<void> {
        await updateMementoValue(this.context.workspaceState, compatibilityStateKeys.favoritesIncludeOnce, Array.from(ids));
    }

    private async clearManualInclude(): Promise<void> {
        await updateMementoValue(this.context.workspaceState, compatibilityStateKeys.favoritesIncludeOnce, []);
    }
}
