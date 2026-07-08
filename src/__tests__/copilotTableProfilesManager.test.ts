import * as vscode from 'vscode';
import { CopilotTableProfilesManager } from '../services/copilot/CopilotTableProfilesManager';
import { FavoritesManager, SchemaFavorite } from '../core/favoritesManager';

function createMockContext(): vscode.ExtensionContext {
    const globalStore = new Map<string, unknown>();
    const workspaceStore = new Map<string, unknown>();
    return {
        globalState: {
            get: <T>(key: string): T | undefined => globalStore.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                globalStore.set(key, value);
            }
        },
        workspaceState: {
            get: <T>(key: string): T | undefined => workspaceStore.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                workspaceStore.set(key, value);
            }
        }
    } as unknown as vscode.ExtensionContext;
}

describe('CopilotTableProfilesManager', () => {
    let mockContext: vscode.ExtensionContext;
    let favoritesManager: FavoritesManager;

    beforeEach(() => {
        // Reset singleton instance
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        mockContext = createMockContext();
        favoritesManager = FavoritesManager.getInstance(mockContext);
    });

    it('should return profiles from favorites', async () => {
        // Add a favorite table directly
        const fav: SchemaFavorite = {
            id: 'SALES_DB.ADMIN.ORDERS',
            type: 'object',
            label: 'ORDERS',
            dbName: 'SALES_DB',
            schema: 'ADMIN',
            objType: 'TABLE',
            customNote: 'Important business table',
            autoInclude: true,
            enabled: true,
            timestamp: Date.now()
        };
        // Access internal cache to add favorite
        const favs = await favoritesManager.getFavorites();
        favs.push(fav);
        await (mockContext.globalState as unknown as { update: (k: string, v: unknown) => Promise<void> }).update('schemaFavorites', favs);
        // Reset to reload
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        favoritesManager = FavoritesManager.getInstance(mockContext);

        const manager = new CopilotTableProfilesManager(mockContext);
        const profiles = await manager.getProfiles();

        expect(profiles).toHaveLength(1);
        expect(profiles[0].database).toBe('SALES_DB');
        expect(profiles[0].schema).toBe('ADMIN');
        expect(profiles[0].table).toBe('ORDERS');
        expect(profiles[0].notes).toBe('Important business table');
    });

    it('should update Copilot settings on existing favorite', async () => {
        // Add a favorite table directly
        const fav: SchemaFavorite = {
            id: 'DB1.SC1.T1',
            type: 'object',
            label: 'T1',
            dbName: 'DB1',
            schema: 'SC1',
            objType: 'TABLE',
            autoInclude: true,
            enabled: true,
            timestamp: Date.now()
        };
        const favs = await favoritesManager.getFavorites();
        favs.push(fav);
        await (mockContext.globalState as unknown as { update: (k: string, v: unknown) => Promise<void> }).update('schemaFavorites', favs);
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        favoritesManager = FavoritesManager.getInstance(mockContext);

        const manager = new CopilotTableProfilesManager(mockContext);

        // Update settings
        await manager.upsertProfile({
            id: 'DB1.SC1.T1',
            database: 'DB1',
            schema: 'SC1',
            table: 'T1',
            autoInclude: false,
            notes: 'Updated notes'
        });

        const profiles = await manager.getProfiles();
        expect(profiles[0].autoInclude).toBe(false);
        expect(profiles[0].notes).toBe('Updated notes');
    });

    it('should include profile once and consume it', async () => {
        // Add a favorite table
        const fav: SchemaFavorite = {
            id: 'DB1.SC1.T1',
            type: 'object',
            label: 'T1',
            dbName: 'DB1',
            schema: 'SC1',
            objType: 'TABLE',
            autoInclude: false,
            enabled: true,
            timestamp: Date.now()
        };
        const favs = await favoritesManager.getFavorites();
        favs.push(fav);
        await (mockContext.globalState as unknown as { update: (k: string, v: unknown) => Promise<void> }).update('schemaFavorites', favs);
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        favoritesManager = FavoritesManager.getInstance(mockContext);

        const manager = new CopilotTableProfilesManager(mockContext);

        await manager.includeNow('DB1.SC1.T1');
        const selected = await manager.consumeProfilesForPrompt();
        const selectedAgain = await manager.consumeProfilesForPrompt();

        expect(selected.map(item => item.id)).toContain('DB1.SC1.T1');
        expect(selectedAgain).toHaveLength(0);
    });

    it('should format profiles for tool output', async () => {
        // Add a favorite table
        const fav: SchemaFavorite = {
            id: 'DB2.SC2.T2',
            type: 'object',
            label: 'T2',
            dbName: 'DB2',
            schema: 'SC2',
            objType: 'TABLE',
            customNote: 'Join with DB2.SC2.T3',
            autoInclude: true,
            enabled: true,
            timestamp: Date.now()
        };
        const favs = await favoritesManager.getFavorites();
        favs.push(fav);
        await (mockContext.globalState as unknown as { update: (k: string, v: unknown) => Promise<void> }).update('schemaFavorites', favs);
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        favoritesManager = FavoritesManager.getInstance(mockContext);

        const manager = new CopilotTableProfilesManager(mockContext);
        const summary = await manager.formatProfilesForToolOutput();

        expect(summary).toContain('Favorite Tables');
        expect(summary).toContain('DB2.SC2.T2');
        expect(summary).toContain('Join with DB2.SC2.T3');
    });

    it('should throw error when trying to create new profile', async () => {
        const manager = new CopilotTableProfilesManager(mockContext);

        await expect(manager.upsertProfile({
            database: 'NEW_DB',
            schema: 'NEW_SCHEMA',
            table: 'NEW_TABLE'
        })).rejects.toThrow('Please add tables to Favorites via the Schema browser');
    });
});
