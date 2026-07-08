import * as vscode from 'vscode';
import { FavoritesManager, SchemaFavorite } from '../core/favoritesManager';
import { SchemaItem } from '../providers/schemaProvider';
import * as fs from 'fs';

jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
        mkdirSync: jest.fn(),
        writeFileSync: jest.fn(),
        renameSync: jest.fn()
    };
});

describe('FavoritesManager', () => {
    let mockGlobalState: { get: jest.Mock; update: jest.Mock };
    let mockWorkspaceState: { get: jest.Mock; update: jest.Mock };
    let mockContext: vscode.ExtensionContext;
    let manager: FavoritesManager;
    let store: Record<string, unknown> = {};
    let workspaceStore: Record<string, unknown> = {};

    beforeEach(() => {
        (fs.existsSync as unknown as jest.Mock).mockReset().mockReturnValue(false);
        (fs.readFileSync as unknown as jest.Mock).mockReset();
        (fs.mkdirSync as unknown as jest.Mock).mockReset().mockReturnValue(undefined);
        (fs.writeFileSync as unknown as jest.Mock).mockReset().mockReturnValue(undefined);
        (fs.renameSync as unknown as jest.Mock).mockReset().mockReturnValue(undefined);
        const workspace = vscode.workspace as unknown as {
            workspaceFolders?: { uri: { fsPath: string } }[];
        };
        workspace.workspaceFolders = undefined;

        store = {};
        workspaceStore = {};
        mockGlobalState = {
            get: jest.fn((key: string) => store[key]),
            update: jest.fn((key: string, value: unknown) => {
                store[key] = value;
                return Promise.resolve();
            })
        };
        mockWorkspaceState = {
            get: jest.fn((key: string) => workspaceStore[key]),
            update: jest.fn((key: string, value: unknown) => {
                workspaceStore[key] = value;
                return Promise.resolve();
            })
        };
        mockContext = {
            globalState: mockGlobalState,
            // standard mock values
            subscriptions: [],
            workspaceState: mockWorkspaceState as unknown as vscode.Memento,
            extensionPath: '',
            storagePath: '',
            globalStoragePath: '',
            logPath: '',
            asAbsolutePath: (p: string) => p,
            storageUri: undefined,
            globalStorageUri: undefined,
            logUri: undefined,
            extensionUri: undefined,
            environmentVariableCollection: undefined,
            extensionMode: 1,
            extension: undefined,
            secrets: undefined
        } as unknown as vscode.ExtensionContext;

        // Force recreation of instance
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should initialize empty if no stored data', async () => {
        const favs = await manager.getFavorites();
        expect(favs).toEqual([]);
    });

    it('should initialize from stored data', async () => {
        const storedFavs: SchemaFavorite[] = [
            { id: '1', type: 'object', connectionName: 'conn', dbName: 'db', label: 'tab1', timestamp: 123 },
            { id: '2', type: 'object', connectionName: 'conn', dbName: 'db', label: 'tab2', timestamp: 456 }
        ];
        store['schemaFavorites'] = storedFavs;

        // Re-init
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);

        const favs = await manager.getFavorites();
        expect(favs.length).toBe(2);
    });

    it('should normalize quoted object labels from stored data', async () => {
        const storedFavs: SchemaFavorite[] = [
            { id: '1', type: 'object', connectionName: 'conn', dbName: 'db', label: '"lower_case_name"', timestamp: 123 }
        ];
        store['schemaFavorites'] = storedFavs;

        // Re-init
        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);

        const favs = await manager.getFavorites();
        expect(favs).toHaveLength(1);
        expect(favs[0].label).toBe('lower_case_name');
    });

    it('should sanitize malformed stored favorites and persist migrated values', async () => {
        store['schemaFavorites'] = [
            null,
            42,
            { label: 'LEGACY_TABLE', connectionName: 'conn', dbName: 'db' },
            { id: '2', type: 'sql', label: 'snippet', sqlContent: 'SELECT 1', timestamp: 123 }
        ];

        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);

        const favs = await manager.getFavorites();
        expect(favs).toHaveLength(2);
        expect(favs[0].type).toBe('object');
        expect(typeof favs[0].id).toBe('string');
        expect(typeof favs[0].timestamp).toBe('number');
        expect(mockGlobalState.update).toHaveBeenCalledWith('schemaFavorites', expect.any(Array));
    });

    it('should add a favorite', async () => {
        const item = new SchemaItem(
            'TEST_TABLE',
            vscode.TreeItemCollapsibleState.None,
            'netezza:TABLE',
            'MYDB',
            'TABLE',
            'MYSCHEMA',
            123,
            undefined,
            'TestConn'
        );

        let eventFired = false;
        manager.onDidChangeFavorites(() => {
            eventFired = true;
        });

        const isNowFavorite = await manager.toggleFavorite(item);

        expect(isNowFavorite).toBe(true);
        expect(eventFired).toBe(true);

        const favs = await manager.getFavorites();
        expect(favs.length).toBe(1);
        expect(favs[0].label).toBe('TEST_TABLE');
        expect(favs[0].dbName).toBe('MYDB');
        expect(favs[0].schema).toBe('MYSCHEMA');
        expect(mockGlobalState.update).toHaveBeenCalledWith('schemaFavorites', expect.any(Array));
    });

    it('should store object favorite label using raw identifier', async () => {
        const item = new SchemaItem(
            '"lower_case_name"',
            vscode.TreeItemCollapsibleState.None,
            'netezza:TABLE',
            'MYDB',
            'TABLE',
            'MYSCHEMA',
            123,
            undefined,
            'TestConn',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'lower_case_name'
        );

        await manager.toggleFavorite(item);

        const favs = await manager.getFavorites();
        expect(favs).toHaveLength(1);
        expect(favs[0].label).toBe('lower_case_name');
    });

    it('should remove a favorite', async () => {
        const item = new SchemaItem(
            'TEST_TABLE',
            vscode.TreeItemCollapsibleState.None,
            'netezza:TABLE',
            'MYDB',
            'TABLE',
            'MYSCHEMA',
            123,
            undefined,
            'TestConn'
        );

        await manager.toggleFavorite(item); // Add
        const isNowFavorite = await manager.toggleFavorite(item); // Remove

        expect(isNowFavorite).toBe(false);
        const favs = await manager.getFavorites();
        expect(favs.length).toBe(0);
    });

    it('should clear all favorites', async () => {
        const item1 = new SchemaItem('T1', vscode.TreeItemCollapsibleState.None, 'netezza:TABLE', 'DB', 'TABLE', 'S1', 1, undefined, 'C1');
        const item2 = new SchemaItem('T2', vscode.TreeItemCollapsibleState.None, 'netezza:TABLE', 'DB', 'TABLE', 'S1', 2, undefined, 'C1');

        await manager.toggleFavorite(item1);
        await manager.toggleFavorite(item2);

        expect((await manager.getFavorites()).length).toBe(2);

        await manager.clearAll();

        expect((await manager.getFavorites()).length).toBe(0);
        expect(mockGlobalState.update).toHaveBeenCalledWith('schemaFavorites', undefined);
    });

    it('should create SQL snippets with autoInclude disabled by default', async () => {
        const id = await manager.addSqlSnippet('Q1', 'SELECT 1;');
        const favs = await manager.getFavorites();
        const snippet = favs.find(f => f.id === id);

        expect(snippet).toBeDefined();
        expect(snippet?.type).toBe('sql');
        expect(snippet?.autoInclude).toBe(false);
    });

    it('should include SQL snippets in Copilot context only when explicitly auto-enabled', async () => {
        const id = await manager.addSqlSnippet('Q2', 'SELECT 2;');

        const initialSelection = await manager.getProfilesForCopilotContext();
        expect(initialSelection.some(item => item.id === id)).toBe(false);

        await manager.setCopilotSettings(id, { autoInclude: true });
        const enabledSelection = await manager.getProfilesForCopilotContext();
        expect(enabledSelection.some(item => item.id === id)).toBe(true);
    });

    it('should load favorites from repository sync file when available', async () => {
        const workspace = vscode.workspace as unknown as {
            workspaceFolders?: { uri: { fsPath: string } }[];
        };
        workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\repo' } }];

        (fs.existsSync as unknown as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as unknown as jest.Mock).mockReturnValue(
            JSON.stringify({
                version: 1,
                favorites: [
                    {
                        id: 'repo-sql-1',
                        type: 'sql',
                        label: 'Repo Snippet',
                        sqlContent: 'SELECT ${id}',
                        timestamp: 123
                    }
                ]
            })
        );

        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);

        const favs = await manager.getFavorites();
        expect(favs).toHaveLength(1);
        expect(favs[0].id).toBe('repo-sql-1');
        expect(favs[0].type).toBe('sql');
        expect(favs[0].sqlContent).toBe('SELECT ${id}');
    });

    it('should save favorites to repository sync file after mutations', async () => {
        const workspace = vscode.workspace as unknown as {
            workspaceFolders?: { uri: { fsPath: string } }[];
        };
        workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\repo' } }];

        (fs.existsSync as unknown as jest.Mock).mockReturnValue(false);
        (fs.mkdirSync as unknown as jest.Mock).mockReturnValue(undefined);
        const writeFileSpy = fs.writeFileSync as unknown as jest.Mock;
        writeFileSpy.mockReturnValue(undefined);

        (FavoritesManager as unknown as { instance: undefined }).instance = undefined;
        manager = FavoritesManager.getInstance(mockContext);
        writeFileSpy.mockClear();

        const item = new SchemaItem(
            'TEST_TABLE',
            vscode.TreeItemCollapsibleState.None,
            'netezza:TABLE',
            'MYDB',
            'TABLE',
            'MYSCHEMA',
            123,
            undefined,
            'TestConn'
        );

        await manager.toggleFavorite(item);

        expect(writeFileSpy).toHaveBeenCalled();
        const [filePath, payload] = writeFileSpy.mock.calls[0];
        expect(String(filePath)).toContain('justybase-favorites.json');
        const parsed = JSON.parse(String(payload)) as { favorites: SchemaFavorite[] };
        expect(parsed.favorites).toHaveLength(1);
        expect(parsed.favorites[0].label).toBe('TEST_TABLE');
    });
});
