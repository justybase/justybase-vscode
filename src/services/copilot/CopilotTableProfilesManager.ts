import * as vscode from 'vscode';
import { FavoritesManager, SchemaFavorite } from '../../core/favoritesManager';

// Re-export types for backwards compatibility
export interface WorkspaceTableProfile {
    id: string;
    type: 'object' | 'sql';
    database: string;
    schema: string;
    table: string;
    sqlContent?: string;
    notes: string;
    autoInclude: boolean;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface UpsertWorkspaceTableProfileInput {
    id?: string;
    database: string;
    schema: string;
    table: string;
    notes?: string;
    autoInclude?: boolean;
    enabled?: boolean;
}

/**
 * CopilotTableProfilesManager now delegates to FavoritesManager.
 * Favorites in Schema serve as the source of truth for Copilot table context.
 */
export class CopilotTableProfilesManager {
    private favoritesManager: FavoritesManager;

    constructor(context: vscode.ExtensionContext) {
        this.favoritesManager = FavoritesManager.getInstance(context);
    }

    public async getProfiles(): Promise<WorkspaceTableProfile[]> {
        const favorites = await this.favoritesManager.getTableProfilesForCopilot();
        return favorites.map(f => this.favoriteToProfile(f));
    }

    public async upsertProfile(input: UpsertWorkspaceTableProfileInput): Promise<WorkspaceTableProfile> {
        // Find existing favorite by database.schema.table pattern
        const favorites = await this.favoritesManager.getTableProfilesForCopilot();
        const profileId = input.id || `${input.database}.${input.schema}.${input.table}`;
        const existing = favorites.find(f =>
            f.id === input.id ||
            (`${f.dbName}.${f.schema}.${f.label}` === profileId)
        );

        if (existing) {
            // Update existing favorite's Copilot settings
            const updated = await this.favoritesManager.setCopilotSettings(existing.id, {
                autoInclude: input.autoInclude,
                enabled: input.enabled
            });
            // Update note if provided
            if (input.notes !== undefined && updated) {
                await this.favoritesManager.updateNote(existing.id, input.notes);
            }
            return this.favoriteToProfile(updated || existing);
        }

        // Cannot create new favorites from here - user must use Schema browser
        throw new Error('Please add tables to Favorites via the Schema browser. Use the star icon on tables to add them to Favorites, then configure Copilot settings there.');
    }

    public async deleteProfile(profileId: string): Promise<void> {
        await this.favoritesManager.removeFavoriteById(profileId);
    }

    public async setAutoInclude(profileId: string, autoInclude: boolean): Promise<WorkspaceTableProfile | undefined> {
        const updated = await this.favoritesManager.setCopilotSettings(profileId, { autoInclude });
        return updated ? this.favoriteToProfile(updated) : undefined;
    }

    public async setEnabled(profileId: string, enabled: boolean): Promise<WorkspaceTableProfile | undefined> {
        const updated = await this.favoritesManager.setCopilotSettings(profileId, { enabled });
        return updated ? this.favoriteToProfile(updated) : undefined;
    }

    public async includeNow(profileId: string): Promise<boolean> {
        return this.favoritesManager.includeNow(profileId);
    }

    public getManualIncludeIds(): string[] {
        // This is now handled internally by FavoritesManager
        return [];
    }

    public async clearManualInclude(_profileId?: string): Promise<void> {
        // Handled by FavoritesManager
    }

    public async consumeProfilesForPrompt(): Promise<WorkspaceTableProfile[]> {
        const favorites = await this.favoritesManager.getProfilesForCopilotContext();
        return favorites.map(f => this.favoriteToProfile(f));
    }

    public async formatProfilesForToolOutput(mode?: 'full' | 'summary' | 'content', profileNames?: string[]): Promise<string> {
        return this.favoritesManager.formatProfilesForToolOutput(mode, profileNames);
    }

    private favoriteToProfile(f: SchemaFavorite): WorkspaceTableProfile {
        return {
            id: f.id,
            type: f.type === 'sql' ? 'sql' : 'object',
            database: f.dbName || '',
            schema: f.schema || '',
            table: f.label,
            sqlContent: f.sqlContent,
            notes: f.customNote || '',
            autoInclude: f.autoInclude !== false, // default true
            enabled: f.enabled !== false, // default true
            createdAt: f.timestamp,
            updatedAt: f.timestamp
        };
    }
}
