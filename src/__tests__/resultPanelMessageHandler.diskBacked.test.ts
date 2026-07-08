jest.mock('../utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

jest.mock('vscode', () => ({
    EventEmitter: jest.fn().mockImplementation(() => {
        const listeners: Array<(data: unknown) => void> = [];
        return {
            event: jest.fn().mockImplementation((callback: (data: unknown) => void) => {
                listeners.push(callback);
                return { dispose: jest.fn() };
            }),
            fire: jest.fn().mockImplementation((data: unknown) => {
                listeners.forEach((callback) => callback(data));
            }),
        };
    }),
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
    },
    commands: {
        executeCommand: jest.fn(),
    },
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue),
        }),
    },
}), { virtual: true });

import { decode } from '@msgpack/msgpack';
import { ResultPanelMessageHandler } from '../views/resultPanelMessageHandler';
import { ResultStateManager } from '../state/resultStateManager';
import { ExportManager } from '../export/exportManager';
import { SqliteResultStore } from '../core/resultDataProvider/sqliteResultStore';
import { diskBackedStoreRegistry } from '../core/resultDataProvider/diskBackedStoreRegistry';

function isNodeSqliteAvailable(): boolean {
    try {
         
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('ResultPanelMessageHandler requestRows', () => {
    afterEach(() => {
        diskBackedStoreRegistry.disposeAll();
    });

    it('returns rowWindow from SQLite store', () => {
        const stateManager = new ResultStateManager();
        const exportManager = new ExportManager(stateManager.resultsMap);
        const postedMessages: unknown[] = [];

        const handler = new ResultPanelMessageHandler(
            stateManager,
            exportManager,
            {
                onUpdateWebview: jest.fn(),
                onPostMessage: (message) => {
                    postedMessages.push(message);
                },
                onForceHydrate: jest.fn(),
            },
        );

        const store = SqliteResultStore.create([{ name: 'id', type: 'INTEGER' }], 100);
        store.insertRows([[1], [2], [3]]);
        diskBackedStoreRegistry.register(store);

        const sourceUri = 'file:///test.sql';
        stateManager.resultsMap.set(sourceUri, [{
            columns: [{ name: 'id', type: 'INTEGER' }],
            data: [],
            storageMode: 'sqlite',
            diskStoreId: store.id,
            totalRowCount: 3,
        }]);

        handler.handleMessage({
            command: 'requestRows',
            sourceUri,
            resultSetIndex: 0,
            offset: 1,
            limit: 2,
            requestId: 42,
        });

        expect(postedMessages).toHaveLength(1);
        const message = postedMessages[0] as {
            command: string;
            offset: number;
            rows: Uint8Array;
            requestId: number;
        };
        expect(message.command).toBe('rowWindow');
        expect(message.offset).toBe(1);
        expect(message.requestId).toBe(42);
        expect(decode(message.rows)).toEqual([[2], [3]]);

        store.dispose();
    });

    it('returns diskQueryResult window with filters and sort', async () => {
        const stateManager = new ResultStateManager();
        const exportManager = new ExportManager(stateManager.resultsMap);
        const postedMessages: unknown[] = [];

        const handler = new ResultPanelMessageHandler(
            stateManager,
            exportManager,
            {
                onUpdateWebview: jest.fn(),
                onPostMessage: (message) => {
                    postedMessages.push(message);
                },
                onForceHydrate: jest.fn(),
            },
        );

        const store = SqliteResultStore.create([
            { name: 'id', type: 'INTEGER' },
            { name: 'name', type: 'VARCHAR' },
        ], 100);
        store.insertRows([[1, 'alpha'], [2, 'beta'], [3, 'alpha']]);
        diskBackedStoreRegistry.register(store);

        const sourceUri = 'file:///filtered.sql';
        stateManager.resultsMap.set(sourceUri, [{
            columns: [
                { name: 'id', type: 'INTEGER' },
                { name: 'name', type: 'VARCHAR' },
            ],
            data: [],
            storageMode: 'sqlite',
            diskStoreId: store.id,
            totalRowCount: 3,
        }]);

        handler.handleMessage({
            command: 'diskQuery',
            sourceUri,
            resultSetIndex: 0,
            requestId: 99,
            action: 'window',
            offset: 0,
            limit: 10,
            querySpec: {
                columnFilters: [{ columnIndex: 1, values: ['alpha'] }],
                sorting: [{ columnIndex: 0, desc: true }],
            },
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(postedMessages.length).toBeGreaterThanOrEqual(1);
        const windowMessage = postedMessages[0] as {
            command: string;
            action: string;
            filteredCount: number;
            rows: Uint8Array;
        };
        expect(windowMessage.command).toBe('diskQueryResult');
        expect(windowMessage.action).toBe('window');
        expect(windowMessage.filteredCount).toBe(2);
        expect(decode(windowMessage.rows)).toEqual([[3, 'alpha'], [1, 'alpha']]);

        await new Promise<void>((resolve) => setImmediate(resolve));
        const countMessage = postedMessages.find((entry) =>
            (entry as { action?: string }).action === 'count'
        ) as { filteredCount: number } | undefined;
        expect(countMessage).toBeUndefined();

        store.dispose();
    });

    it('returns diskQueryResult groups for SQLite-backed results', async () => {
        const stateManager = new ResultStateManager();
        const exportManager = new ExportManager(stateManager.resultsMap);
        const postedMessages: unknown[] = [];

        const handler = new ResultPanelMessageHandler(
            stateManager,
            exportManager,
            {
                onUpdateWebview: jest.fn(),
                onPostMessage: (message) => {
                    postedMessages.push(message);
                },
                onForceHydrate: jest.fn(),
            },
        );

        const store = SqliteResultStore.create([
            { name: 'id', type: 'INTEGER' },
            { name: 'region', type: 'VARCHAR' },
            { name: 'status', type: 'VARCHAR' },
        ], 100);
        store.insertRows([
            [1, 'EU', 'open'],
            [2, 'EU', 'closed'],
            [3, 'US', 'open'],
        ]);
        diskBackedStoreRegistry.register(store);

        const sourceUri = 'file:///grouped.sql';
        stateManager.resultsMap.set(sourceUri, [{
            columns: [
                { name: 'id', type: 'INTEGER' },
                { name: 'region', type: 'VARCHAR' },
                { name: 'status', type: 'VARCHAR' },
            ],
            data: [],
            storageMode: 'sqlite',
            diskStoreId: store.id,
            totalRowCount: 3,
        }]);

        handler.handleMessage({
            command: 'diskQuery',
            sourceUri,
            resultSetIndex: 0,
            requestId: 123,
            action: 'group',
            offset: 0,
            limit: 10,
            grouping: [{ columnIndex: 1 }, { columnIndex: 2 }],
            groupPath: [],
            querySpec: {
                sorting: [{ columnIndex: 1, desc: false }],
            },
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        const message = postedMessages[0] as {
            command: string;
            action: string;
            requestId: number;
            groupResult?: {
                kind: string;
                totalCount: number;
                groups?: Array<{ value: unknown; count: number; path: unknown[] }>;
            };
        };
        expect(message.command).toBe('diskQueryResult');
        expect(message.action).toBe('group');
        expect(message.requestId).toBe(123);
        expect(message.groupResult?.kind).toBe('groups');
        expect(message.groupResult?.totalCount).toBe(2);
        expect(message.groupResult?.groups?.map((group) => ({
            value: group.value,
            count: group.count,
        }))).toEqual([
            { value: 'EU', count: 2 },
            { value: 'US', count: 1 },
        ]);

        postedMessages.length = 0;
        handler.handleMessage({
            command: 'diskQuery',
            sourceUri,
            resultSetIndex: 0,
            requestId: 124,
            action: 'group',
            offset: 0,
            limit: 10,
            grouping: [{ columnIndex: 1 }, { columnIndex: 2 }],
            groupPath: [{ columnIndex: 1, value: 'EU' }],
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        const nestedMessage = postedMessages[0] as {
            groupResult?: {
                groups?: Array<{ value: unknown; count: number }>;
            };
        };
        expect(nestedMessage.groupResult?.groups?.map((group) => ({
            value: group.value,
            count: group.count,
        }))).toEqual([
            { value: 'closed', count: 1 },
            { value: 'open', count: 1 },
        ]);

        store.dispose();
    });
});
