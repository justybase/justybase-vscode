/**
 * Tests for keyboard-first query history search (netezza.searchQueryHistory).
 */

import * as vscode from 'vscode';
import type { QueryHistoryEntry } from '../core/history/types';
import {
    firstLineOfSql,
    formatHistoryTime,
    mergeHistorySearchResults,
    rankHistoryEntries,
    toHistoryQuickPickDescription,
    toHistoryQuickPickDetail,
    toHistoryQuickPickLabel,
} from '../utils/queryHistoryQuickPick';
import { registerQueryHistoryQuickPickCommands } from '../commands/schema/queryHistoryQuickPickCommands';

jest.mock('../core/queryHistoryManager', () => ({
    QueryHistoryManager: {
        getInstance: jest.fn(),
    },
}));

jest.mock('../core/variableResolver', () => ({
    resolveQueryVariables: jest.fn(async (query: string) => query),
}));

import { QueryHistoryManager } from '../core/queryHistoryManager';
import { resolveQueryVariables } from '../core/variableResolver';

const getInstance = QueryHistoryManager.getInstance as unknown as jest.Mock;
const mockResolveVariables = resolveQueryVariables as unknown as jest.Mock;

interface CapturedQuickPick {
    instance: {
        title: string;
        placeholder: string;
        matchOnDescription: boolean;
        matchOnDetail: boolean;
        ignoreFocusOut: boolean;
        busy: boolean;
        items: TestItem[];
        activeItems: TestItem[];
        selectedItems: TestItem[];
        show: jest.Mock;
        dispose: jest.Mock;
    };
    onValue: (value: string) => void;
    onAccept: () => void;
    onHide: () => void;
}

interface TestItem {
    label: string;
    description?: string;
    detail?: string;
    entryId: string;
    entry: QueryHistoryEntry;
}

function createEntry(overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
    return {
        id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
        host: overrides.host ?? 'nzhost',
        database: overrides.database ?? 'DEVDB',
        schema: overrides.schema ?? 'PUBLIC',
        query: overrides.query ?? 'SELECT * FROM CUSTOMER',
        timestamp: overrides.timestamp ?? Date.now(),
        connectionName: overrides.connectionName ?? 'dev',
        is_favorite: overrides.is_favorite ?? false,
        tags: overrides.tags ?? '',
        description: overrides.description ?? '',
        status: overrides.status,
    };
}

function setActiveEditor(languageId: string | undefined): { edit: jest.Mock; insert: jest.Mock } {
    const insert = jest.fn();
    const edit = jest.fn(async (callback: (builder: { insert: jest.Mock }) => void) => {
        callback({ insert });
        return true;
    });
    if (languageId === undefined) {
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
    } else {
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: { languageId, uri: { toString: () => 'file:///test.sql' } },
            selection: { active: { line: 0, character: 0 } },
            edit,
        };
    }
    return { edit, insert };
}

function mockCreateQuickPick(): { captured: CapturedQuickPick[]; mockFn: jest.Mock } {
    const captured: CapturedQuickPick[] = [];
    const mockFn = jest.fn(() => {
        let valueHandler: ((value: string) => void) | undefined;
        let acceptHandler: (() => void) | undefined;
        let hideHandler: (() => void) | undefined;
        const instance = {
            title: '',
            placeholder: '',
            matchOnDescription: false,
            matchOnDetail: false,
            ignoreFocusOut: false,
            busy: false,
            items: [] as TestItem[],
            activeItems: [] as TestItem[],
            selectedItems: [] as TestItem[],
            show: jest.fn(),
            dispose: jest.fn(),
            onDidChangeValue: jest.fn((handler: (value: string) => void) => {
                valueHandler = handler;
                return { dispose: jest.fn() };
            }),
            onDidChangeActive: jest.fn(() => ({ dispose: jest.fn() })),
            onDidAccept: jest.fn((handler: () => void) => {
                acceptHandler = handler;
                return { dispose: jest.fn() };
            }),
            onDidHide: jest.fn((handler: () => void) => {
                hideHandler = handler;
                return { dispose: jest.fn() };
            }),
        };
        captured.push({
            instance: instance as unknown as CapturedQuickPick['instance'],
            onValue: (value: string) => valueHandler?.(value),
            onAccept: () => acceptHandler?.(),
            onHide: () => hideHandler?.(),
        });
        return instance;
    });
    (vscode.window as unknown as { createQuickPick?: unknown }).createQuickPick = mockFn;
    return { captured, mockFn };
}

function createManager(entries: QueryHistoryEntry[], archive: QueryHistoryEntry[] = []) {
    return {
        getHistory: jest.fn(async () => [...entries]),
        filterEntries: jest.fn(async (filter: { searchTerm?: string }) => {
            const term = (filter.searchTerm ?? '').toLowerCase();
            return entries.filter((entry) => entry.query.toLowerCase().includes(term));
        }),
        searchArchive: jest.fn(async (term: string) => {
            const lowered = term.toLowerCase();
            return archive.filter((entry) => entry.query.toLowerCase().includes(lowered));
        }),
        getEntryById: jest.fn(async (id: string) => [...entries, ...archive].find((entry) => entry.id === id)),
    };
}

function getRegisteredHandler(): (...args: unknown[]) => Promise<void> {
    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
    const found = calls.find((call) => call[0] === 'netezza.searchQueryHistory');
    if (!found) {
        throw new Error('netezza.searchQueryHistory was not registered');
    }
    return found[1] as (...args: unknown[]) => Promise<void>;
}

const createDeps = () => ({
    context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
    connectionManager: {} as unknown as import('../core/connectionManager').ConnectionManager,
    metadataCache: {} as unknown as import('../metadataCache').MetadataCache,
    schemaProvider: {} as unknown as import('../providers/schemaProvider').SchemaProvider,
    schemaTreeView: {} as unknown as vscode.TreeView<import('../providers/schemaProvider').SchemaItem>,
});

async function flushMicrotasks(times = 20): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await Promise.resolve();
    }
}

describe('query history QuickPick helpers', () => {
    it('uses the first non-empty line and truncates long labels', () => {
        expect(firstLineOfSql('\n  SELECT * FROM CUSTOMER\nWHERE ID > 1')).toBe('SELECT * FROM CUSTOMER');
        expect(firstLineOfSql('   \n  ')).toBe('(empty query)');
        expect(firstLineOfSql('SELECT ' + 'x'.repeat(200), 80)).toHaveLength(80);
    });

    it('formats today, yesterday, and older timestamps', () => {
        const now = new Date(2026, 9, 10, 18, 51).getTime();
        expect(formatHistoryTime(new Date(2026, 9, 10, 17, 42).getTime(), now)).toBe('17:42');
        expect(formatHistoryTime(new Date(2026, 9, 9, 12, 0).getTime(), now)).toBe('Yesterday');
        expect(formatHistoryTime(new Date(2026, 8, 3, 9, 0).getTime(), now)).toBe('Sep 3');
        expect(formatHistoryTime(new Date(2025, 5, 1, 9, 0).getTime(), now)).toBe('Jun 1, 2025');
    });

    it('marks favorites and shows connection/database context', () => {
        const favorite = createEntry({ is_favorite: true, query: 'SELECT 1' });
        expect(toHistoryQuickPickLabel(favorite).startsWith('$(star-full)')).toBe(true);
        expect(toHistoryQuickPickLabel(createEntry({ query: 'SELECT 1' }))).toBe('SELECT 1');

        const description = toHistoryQuickPickDescription(
            createEntry({ connectionName: 'dev', database: 'DEVDB', timestamp: Date.now() }),
        );
        expect(description).toContain('dev');
        expect(description).toContain('DEVDB');

        expect(toHistoryQuickPickDescription(createEntry({ status: 'error' }))).toContain('$(error)');
        expect(toHistoryQuickPickDetail(createEntry({ query: 'x'.repeat(500) }))).toHaveLength(300);
    });

    it('ranks favorites first, then newest', () => {
        const oldFavorite = createEntry({ id: 'fav', is_favorite: true, timestamp: 100 });
        const newer = createEntry({ id: 'new', timestamp: 300 });
        const older = createEntry({ id: 'old', timestamp: 200 });
        expect(rankHistoryEntries([newer, older, oldFavorite]).map((entry) => entry.id)).toEqual([
            'fav',
            'new',
            'old',
        ]);
    });

    it('merges active and archive results without duplicates', () => {
        const shared = createEntry({ id: 'same' });
        const merged = mergeHistorySearchResults([shared], [shared, createEntry({ id: 'arch' })]);
        expect(merged.map((entry) => entry.id)).toEqual(['same', 'arch']);
    });
});

describe('netezza.searchQueryHistory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveVariables.mockImplementation(async (query: string) => query);
        setActiveEditor(undefined);
    });

    it('registers the command', () => {
        const disposables = registerQueryHistoryQuickPickCommands(createDeps());
        expect(disposables).toHaveLength(1);
        expect(getRegisteredHandler()).toBeDefined();
    });

    it('warns outside supported SQL editors and never opens the picker', async () => {
        const { mockFn } = mockCreateQuickPick();
        registerQueryHistoryQuickPickCommands(createDeps());
        setActiveEditor('plaintext');

        await getRegisteredHandler()();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'Search Query History is only available for SQL files.',
        );
        expect(mockFn).not.toHaveBeenCalled();
    });

    it('inserts the chosen entry at the cursor and never executes it', async () => {
        const entries = [
            createEntry({ id: 'recent', query: 'SELECT * FROM CUSTOMER', timestamp: 200 }),
            createEntry({ id: 'older', query: 'SELECT c.ID FROM CUSTOMER c', timestamp: 100 }),
        ];
        getInstance.mockReturnValue(createManager(entries));
        mockCreateQuickPick();
        registerQueryHistoryQuickPickCommands(createDeps());
        const { edit, insert } = setActiveEditor('sql');

        const pending = getRegisteredHandler()();
        await flushMicrotasks();
        const quickPick = (vscode.window.createQuickPick as jest.Mock).mock.results[0]
            .value as CapturedQuickPick['instance'] & {
            onDidAccept: jest.Mock;
        };
        const acceptHandler = quickPick.onDidAccept.mock.calls[0][0] as () => void;
        quickPick.activeItems = [quickPick.items[0]];
        acceptHandler();
        await pending;

        expect(edit).toHaveBeenCalledTimes(1);
        expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'SELECT * FROM CUSTOMER');
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
            'netezza.runQuery',
            expect.anything(),
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('netezza.runQuery');
        expect(quickPick.dispose).toHaveBeenCalled();
    });

    it('searches active history and archive while typing', async () => {
        const active = [createEntry({ id: 'a1', query: 'SELECT * FROM CUSTOMER_ORDERS' })];
        const archived = [createEntry({ id: 'x1', query: 'WITH CUSTOMER_ORDERS AS (SELECT 1) SELECT * FROM CUSTOMER_ORDERS' })];
        const manager = createManager(active, archived);
        getInstance.mockReturnValue(manager);
        const { captured } = mockCreateQuickPick();
        registerQueryHistoryQuickPickCommands(createDeps());
        setActiveEditor('netezza-sql');

        const pending = getRegisteredHandler()();
        await flushMicrotasks();
        captured[0].onValue('customer_orders');
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(manager.filterEntries).toHaveBeenCalledWith({ searchTerm: 'customer_orders' });
        expect(manager.searchArchive).toHaveBeenCalledWith('customer_orders');
        const ids = captured[0].instance.items.map((item) => item.entryId).sort();
        expect(ids).toEqual(['a1', 'x1']);

        captured[0].instance.activeItems = [captured[0].instance.items[0]];
        captured[0].onAccept();
        await pending;
        expect(manager.getEntryById).toHaveBeenCalled();
    });

    it('returns silently when parameter input is cancelled', async () => {
        const entries = [createEntry({ id: 'p1', query: 'SELECT * FROM T WHERE A = ${X}' })];
        getInstance.mockReturnValue(createManager(entries));
        mockCreateQuickPick();
        mockResolveVariables.mockRejectedValueOnce(new Error('Variable input cancelled by user'));
        registerQueryHistoryQuickPickCommands(createDeps());
        const { edit } = setActiveEditor('sql');

        const pending = getRegisteredHandler()();
        await flushMicrotasks();
        const quickPick = (vscode.window.createQuickPick as jest.Mock).mock.results[0]
            .value as CapturedQuickPick['instance'] & { onDidAccept: jest.Mock };
        quickPick.activeItems = [quickPick.items[0]];
        (quickPick.onDidAccept.mock.calls[0][0] as () => void)();
        await pending;

        expect(edit).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('falls back to a new SQL document when the editor closes before insert', async () => {
        const entries = [createEntry({ id: 'f1', query: 'SELECT 1' })];
        getInstance.mockReturnValue(createManager(entries));
        mockCreateQuickPick();
        registerQueryHistoryQuickPickCommands(createDeps());
        setActiveEditor('sql');
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: {} });

        const pending = getRegisteredHandler()();
        await flushMicrotasks();
        const quickPick = (vscode.window.createQuickPick as jest.Mock).mock.results[0]
            .value as CapturedQuickPick['instance'] & { onDidAccept: jest.Mock };
        quickPick.activeItems = [quickPick.items[0]];
        (quickPick.onDidAccept.mock.calls[0][0] as () => void)();
        setActiveEditor(undefined);
        await pending;

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
            content: 'SELECT 1',
            language: 'sql',
        });
    });
});
