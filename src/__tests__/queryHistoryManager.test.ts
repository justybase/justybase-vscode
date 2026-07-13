import * as vscode from 'vscode';
import { QueryHistoryEntry, QueryHistoryManager } from '../core/queryHistoryManager';
import { HistoryStats } from '../core/history/types';

const mockStorage = {
    loadActive: jest.fn<Promise<QueryHistoryEntry[]>, []>(),
    saveActive: jest.fn<Promise<void>, [QueryHistoryEntry[]]>(),
    appendToArchive: jest.fn<Promise<void>, [QueryHistoryEntry[]]>(),
    clearAll: jest.fn<Promise<void>, []>(),
    getStats: jest.fn<Promise<HistoryStats>, [number]>(),
    getArchiveEntries: jest.fn<Promise<QueryHistoryEntry[]>, []>(),
    clearArchiveOnly: jest.fn<Promise<void>, []>()
};

jest.mock('../core/history/historyStorage', () => ({
    HistoryStorage: jest.fn(() => mockStorage)
}));

const createEntry = (overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    host: overrides.host ?? 'localhost',
    database: overrides.database ?? 'TESTDB',
    schema: overrides.schema ?? 'PUBLIC',
    query: overrides.query ?? 'SELECT 1',
    timestamp: overrides.timestamp ?? Date.now(),
    connectionName: overrides.connectionName,
    is_favorite: overrides.is_favorite ?? false,
    tags: overrides.tags ?? '',
    description: overrides.description ?? ''
});

const createContext = (legacyEntries?: QueryHistoryEntry[]): vscode.ExtensionContext => {
    const globalState = {
        get: jest.fn().mockReturnValue(legacyEntries ? { entries: legacyEntries, version: 1 } : undefined),
        update: jest.fn().mockResolvedValue(undefined)
    };

    return {
        globalStorageUri: { fsPath: 'C:\\temp\\history' } as vscode.Uri,
        globalState: globalState as unknown as vscode.Memento,
        subscriptions: []
    } as unknown as vscode.ExtensionContext;
};

const resetSingleton = (): void => {
    (QueryHistoryManager as unknown as { instance?: QueryHistoryManager }).instance = undefined;
};

describe('QueryHistoryManager', () => {
    const defaultStats: HistoryStats = {
        activeEntries: 0,
        archivedEntries: 0,
        totalEntries: 0,
        activeFileSizeMB: 0,
        archiveFileSizeMB: 0,
        totalFileSizeMB: 0
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        resetSingleton();

        mockStorage.loadActive.mockResolvedValue([]);
        mockStorage.saveActive.mockResolvedValue(undefined);
        mockStorage.appendToArchive.mockResolvedValue(undefined);
        mockStorage.clearAll.mockResolvedValue(undefined);
        mockStorage.getStats.mockResolvedValue(defaultStats);
        mockStorage.getArchiveEntries.mockResolvedValue([]);
        mockStorage.clearArchiveOnly.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it('loads active history from storage on initialization', async () => {
        const entries = [createEntry({ id: 'entry-1', query: 'SELECT * FROM users' })];
        mockStorage.loadActive.mockResolvedValue(entries);
        const manager = new QueryHistoryManager(createContext());

        const history = await manager.getHistory();

        expect(mockStorage.loadActive).toHaveBeenCalledTimes(1);
        expect(history).toEqual(entries);
        expect(QueryHistoryManager.hasInstance()).toBe(false);
    });

    it('migrates legacy globalState history when active storage is empty', async () => {
        const legacyEntries = [createEntry({ id: 'legacy-1', query: 'SELECT legacy' })];
        const context = createContext(legacyEntries);
        const manager = new QueryHistoryManager(context);

        const history = await manager.getHistory();
        const globalState = context.globalState as unknown as {
            update: jest.Mock;
        };

        expect(history).toEqual(legacyEntries);
        expect(mockStorage.saveActive).toHaveBeenCalledWith(legacyEntries);
        expect(globalState.update).toHaveBeenCalledWith('queryHistory', undefined);
    });

    it('handles initialization errors gracefully', async () => {
        mockStorage.loadActive.mockRejectedValue(new Error('load failed'));
        const manager = new QueryHistoryManager(createContext());

        const history = await manager.getHistory();

        expect(history).toEqual([]);
    });

    it('supports singleton access through getInstance', async () => {
        const context = createContext();

        const instanceA = QueryHistoryManager.getInstance(context);
        const instanceB = QueryHistoryManager.getInstance(context);

        await instanceA.getHistory();
        expect(instanceA).toBe(instanceB);
        expect(QueryHistoryManager.hasInstance()).toBe(true);
    });

    it('does not persist internal/system queries', async () => {
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        await manager.addEntry('localhost', 'TESTDB', 'PUBLIC', 'SELECT system', undefined, undefined, undefined, false);

        const history = await manager.getHistory();
        expect(history).toHaveLength(0);
        expect(mockStorage.saveActive).not.toHaveBeenCalled();
    });

    it('adds entries, emits event and performs debounced save', async () => {
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();
        const listener = jest.fn();
        manager.onDidAddEntry(listener);

        await manager.addEntry('localhost', 'TESTDB', 'PUBLIC', '   SELECT * FROM users   ', 'conn1', 'tagA', 'descA');

        const history = await manager.getHistory();
        expect(history).toHaveLength(1);
        expect(history[0].query).toBe('SELECT * FROM users');
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ query: 'SELECT * FROM users' }));
        expect(mockStorage.saveActive).not.toHaveBeenCalled();

        jest.advanceTimersByTime(15000);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockStorage.saveActive).toHaveBeenCalledTimes(1);
    });

    it('flushes overflow history to archive when active cache exceeds limit', async () => {
        const largeEntries = Array.from({ length: 1002 }, (_v, index) =>
            createEntry({ id: `entry-${index}`, timestamp: Date.now() - index })
        );
        mockStorage.loadActive.mockResolvedValue(largeEntries);
        const manager = new QueryHistoryManager(createContext());

        const history = await manager.getHistory();
        const savedActive = mockStorage.saveActive.mock.calls[0][0];
        const archived = mockStorage.appendToArchive.mock.calls[0][0];

        expect(history).toHaveLength(900);
        expect(savedActive).toHaveLength(900);
        expect(archived).toHaveLength(102);
        expect(mockStorage.appendToArchive).toHaveBeenCalledTimes(1);
    });

    it('flushes again when concurrent entries refill the cache during disk I/O', async () => {
        const initialEntries = Array.from({ length: 999 }, (_v, index) =>
            createEntry({ id: `initial-${index}`, timestamp: Date.now() - index })
        );
        mockStorage.loadActive.mockResolvedValue(initialEntries);

        let releaseFirstSave: (() => void) | undefined;
        const firstSaveBlocked = new Promise<void>(resolve => {
            releaseFirstSave = resolve;
        });
        mockStorage.saveActive
            .mockImplementationOnce(() => firstSaveBlocked)
            .mockResolvedValue(undefined);

        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        const firstAdd = manager.addEntry('host', 'db', 'schema', 'SELECT first');
        await Promise.resolve();
        expect(mockStorage.saveActive).toHaveBeenCalledTimes(1);

        const burstAdds = Array.from({ length: 100 }, (_v, index) =>
            manager.addEntry('host', 'db', 'schema', `SELECT burst_${index}`)
        );
        releaseFirstSave?.();
        await Promise.all([firstAdd, ...burstAdds]);

        const history = await manager.getHistory();
        expect(history).toHaveLength(900);
        expect(mockStorage.saveActive).toHaveBeenCalledTimes(2);
        expect(mockStorage.appendToArchive).toHaveBeenCalledTimes(2);
        expect(mockStorage.appendToArchive.mock.calls.flatMap(call => call[0])).toHaveLength(200);
    });

    it('supports pagination with limit and offset', async () => {
        const entries = [
            createEntry({ id: 'e1', query: 'Q1' }),
            createEntry({ id: 'e2', query: 'Q2' }),
            createEntry({ id: 'e3', query: 'Q3' })
        ];
        mockStorage.loadActive.mockResolvedValue(entries);
        const manager = new QueryHistoryManager(createContext());

        const page = await manager.getHistory(2, 1);

        expect(page.map(entry => entry.id)).toEqual(['e2', 'e3']);
    });

    it('deletes entries and saves only when entry existed', async () => {
        const entries = [createEntry({ id: 'e1' }), createEntry({ id: 'e2' })];
        mockStorage.loadActive.mockResolvedValue(entries);
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        await manager.deleteEntry('e1');
        expect(mockStorage.saveActive).toHaveBeenCalledTimes(1);
        expect(mockStorage.saveActive).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'e2' })]);

        mockStorage.saveActive.mockClear();
        await manager.deleteEntry('missing-id');
        expect(mockStorage.saveActive).not.toHaveBeenCalled();
    });

    it('clears all history and storage', async () => {
        mockStorage.loadActive.mockResolvedValue([createEntry({ id: 'e1' })]);
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        await manager.clearHistory();
        const history = await manager.getHistory();

        expect(history).toEqual([]);
        expect(mockStorage.clearAll).toHaveBeenCalledTimes(1);
    });

    it('toggles favorites, updates entries and provides derived views', async () => {
        mockStorage.loadActive.mockResolvedValue([
            createEntry({ id: 'a', query: 'SELECT A', tags: 'alpha, beta' }),
            createEntry({ id: 'b', query: 'SELECT B', tags: 'beta, gamma' })
        ]);
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        await manager.toggleFavorite('a');
        await manager.updateEntry('b', 'delta,epsilon', 'updated description');

        const favorites = await manager.getFavorites();
        const tagFiltered = await manager.getByTag('EPSILON');
        const allTags = await manager.getAllTags();

        expect(favorites.map(entry => entry.id)).toEqual(['a']);
        expect(tagFiltered.map(entry => entry.id)).toEqual(['b']);
        expect(allTags).toEqual(['alpha', 'beta', 'delta', 'epsilon']);
        expect(mockStorage.saveActive).toHaveBeenCalledTimes(2);
    });

    it('searches active and archive entries and handles archive errors', async () => {
        mockStorage.loadActive.mockResolvedValue([
            createEntry({ id: 'a1', query: 'SELECT * FROM orders', tags: 'prod' }),
            createEntry({ id: 'a2', query: 'SELECT * FROM users', description: 'contains archive keyword' })
        ]);
        mockStorage.getArchiveEntries.mockResolvedValue([
            createEntry({ id: 'r1', query: 'ARCHIVE QUERY', description: 'old archive row' }),
            createEntry({ id: 'r2', query: 'NO MATCH' })
        ]);

        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        const activeResults = await manager.searchAll('orders');
        const archiveResults = await manager.searchArchive('archive');

        expect(activeResults.map(entry => entry.id)).toEqual(['a1']);
        expect(archiveResults.map(entry => entry.id)).toEqual(['r1']);

        mockStorage.getArchiveEntries.mockRejectedValueOnce(new Error('archive failure'));
        await expect(manager.searchArchive('anything')).resolves.toEqual([]);
    });

    it('filters by host/database/schema and limit', async () => {
        mockStorage.loadActive.mockResolvedValue([
            createEntry({ id: 'e1', host: 'h1', database: 'db1', schema: 's1' }),
            createEntry({ id: 'e2', host: 'h1', database: 'db2', schema: 's1' }),
            createEntry({ id: 'e3', host: 'h2', database: 'db1', schema: 's2' })
        ]);
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        const filtered = await manager.getFilteredHistory('h1', 'db1', 's1', 10);
        expect(filtered.map(entry => entry.id)).toEqual(['e1']);
    });

    it('forces save when pending changes exist and closes cleanly', async () => {
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        await manager.addEntry('localhost', 'TESTDB', 'PUBLIC', 'SELECT save_me');
        await manager.forceSave();
        await manager.close();

        expect(mockStorage.saveActive).toHaveBeenCalled();
    });

    it('returns stats, clears archive, and keeps archived history disabled', async () => {
        const expectedStats: HistoryStats = {
            activeEntries: 3,
            archivedEntries: 2,
            totalEntries: 5,
            activeFileSizeMB: 1.2,
            archiveFileSizeMB: 3.4,
            totalFileSizeMB: 4.6
        };
        mockStorage.getStats.mockResolvedValue(expectedStats);
        const manager = new QueryHistoryManager(createContext());
        await manager.getHistory();

        const stats = await manager.getStats();
        const archivedHistory = await manager.getArchivedHistory();
        await manager.clearArchive();

        expect(stats).toEqual(expectedStats);
        expect(archivedHistory).toEqual([]);
        expect(mockStorage.clearArchiveOnly).toHaveBeenCalledTimes(1);
    });

    // ====================
    // Saved Filter Views Tests
    // ====================

    it('parses query parameters from SQL', () => {
        // These are synchronous methods that don't require initialization
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        // Use constructor directly to avoid singleton issues
        const manager = new QueryHistoryManager(context);

        // Test different parameter patterns
        const query1 = 'SELECT * FROM table WHERE id = :id AND name = :name';
        let params = manager.parseQueryParameters(query1);
        expect(params).toHaveLength(2);
        expect(params.map(p => p.name)).toContain('id');
        expect(params.map(p => p.name)).toContain('name');

        // Test ${param} pattern
        const query2 = 'SELECT * FROM table WHERE date >= ${startDate}';
        params = manager.parseQueryParameters(query2);
        expect(params).toHaveLength(1);
        expect(params[0].name).toBe('startDate');

        // Test {param} pattern (braces only)
        const query2b = 'SELECT * FROM {tableName} WHERE id = {id}';
        params = manager.parseQueryParameters(query2b);
        expect(params).toHaveLength(2);
        expect(params.map(p => p.name)).toContain('tableName');
        expect(params.map(p => p.name)).toContain('id');

        // Test @param pattern
        const query3 = 'SELECT * FROM table WHERE id = @userId';
        params = manager.parseQueryParameters(query3);
        expect(params).toHaveLength(1);
        expect(params[0].name).toBe('userId');

        // Test no parameters
        const query4 = 'SELECT * FROM table';
        params = manager.parseQueryParameters(query4);
        expect(params).toHaveLength(0);
    });

    it('substitutes parameters in query', () => {
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        const manager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM table WHERE id = :id AND name = :name';
        const parameters = [
            { name: 'id', value: '123', type: 'string' as const, required: true },
            { name: 'name', value: 'John', type: 'string' as const, required: true }
        ];

        const result = manager.substituteParameters(query, parameters);
        expect(result).toBe("SELECT * FROM table WHERE id = '123' AND name = 'John'");
    });

    it('should substitute {param} pattern in query', () => {
        const context = createContext();
        const historyManager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM {table} WHERE id = {id}';
        const parameters = [
            { name: 'table', value: 'users', type: 'string' as const, required: true },
            { name: 'id', value: '42', type: 'number' as const, required: true }
        ];

        const result = historyManager.substituteParameters(query, parameters);
        expect(result).toBe("SELECT * FROM 'users' WHERE id = 42");
    });

    it('validates numeric parameters in substitution', () => {
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        const manager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM table WHERE amount > :minAmount';
        const parameters = [
            { name: 'minAmount', value: '100.50', type: 'number' as const, required: true }
        ];

        const result = manager.substituteParameters(query, parameters);
        expect(result).toBe('SELECT * FROM table WHERE amount > 100.50');
    });

    it('throws error for invalid numeric parameter', () => {
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        const manager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM table WHERE amount > :minAmount';
        const parameters = [
            { name: 'minAmount', value: 'abc', type: 'number' as const, required: true }
        ];

        expect(() => manager.substituteParameters(query, parameters)).toThrow(
            "Invalid numeric value for parameter 'minAmount': abc"
        );
    });

    it('validates boolean parameters in substitution', () => {
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        const manager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM table WHERE is_active = :active';
        const parameters = [
            { name: 'active', value: 'true', type: 'boolean' as const, required: true }
        ];

        const result = manager.substituteParameters(query, parameters);
        expect(result).toBe('SELECT * FROM table WHERE is_active = TRUE');
    });

    it('throws error for invalid boolean parameter', () => {
        const context = createContext();
        mockStorage.loadActive.mockResolvedValue([createEntry()]);

        const manager = new QueryHistoryManager(context);

        const query = 'SELECT * FROM table WHERE is_active = :active';
        const parameters = [
            { name: 'active', value: 'invalid', type: 'boolean' as const, required: true }
        ];

        expect(() => manager.substituteParameters(query, parameters)).toThrow(
            "Invalid boolean value for parameter 'active': invalid"
        );
    });

});
