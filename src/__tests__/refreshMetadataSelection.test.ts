import * as vscode from 'vscode';
import { registerRefreshMetadataCommands } from '../commands/schema/refreshMetadataCommands';
import type { SchemaCommandsDependencies } from '../commands/schema/types';
import type { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadata/cache/MetadataCache';
import { TableDdlSynchronizer } from '../metadata/tableDdlSynchronizer';
import { SchemaItem, type SchemaProvider } from '../providers/schemaProvider';
import { Logger } from '../utils/logger';

jest.mock('vscode');
jest.mock('../core/queryRunner', () => ({
	runQueryRaw: jest.fn(async () => ({
		columns: ['OBJNAME', 'SCHEMA', 'OBJID', 'OWNER', 'DESCRIPTION'],
		rows: [['JBL_T', 'APP', 1, 'DB2INST1', '']],
	})),
	queryResultToRows: jest.fn((result: { columns: string[]; rows: unknown[][] }) =>
		(result.rows ?? []).map((row) => {
			const mapped: Record<string, unknown> = {};
			result.columns.forEach((column, index) => {
				mapped[column] = row[index];
			});
			return mapped;
		}),
	),
}));
jest.mock('../core/connectionFactory', () => ({
	getDatabaseMetadataProvider: jest.fn(() => ({
		defaultObjectTypes: ['TABLE', 'VIEW', 'PROCEDURE'],
		buildObjectTypeQuery: jest.fn(() => 'SELECT 1'),
	})),
}));

describe('cross-dialect metadata refresh', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		Logger.initialize({
			appendLine: jest.fn(),
			show: jest.fn(),
			dispose: jest.fn(),
			name: 'test',
			clear: jest.fn(),
			append: jest.fn(),
			replace: jest.fn(),
			hide: jest.fn(),
		} as unknown as vscode.OutputChannel);
		(vscode.window as unknown as { withProgress: jest.Mock }).withProgress = jest.fn(
			async (_options: unknown, task: () => Promise<unknown>) => task(),
		);
		(vscode as unknown as { ProgressLocation: { Window: number } }).ProgressLocation = { Window: 10 };
	});

	it('clearConnectionMetadata removes only that connection', () => {
		const cache = new MetadataCache({
			globalStorageUri: vscode.Uri.file('/tmp/clear-connection-metadata'),
		} as vscode.ExtensionContext);

		cache.setDatabases('CONN_A', [{ DATABASE: 'A', label: 'A' }]);
		cache.setDatabases('CONN_B', [{ DATABASE: 'B', label: 'B' }]);
		cache.setTables(
			'CONN_A',
			'A.S',
			[{ OBJNAME: 'T1', SCHEMA: 'S', label: 'T1', objType: 'TABLE' }],
			new Map(),
		);
		cache.setTables(
			'CONN_B',
			'B.S',
			[{ OBJNAME: 'T2', SCHEMA: 'S', label: 'T2', objType: 'TABLE' }],
			new Map(),
		);
		cache.setTypeGroups('CONN_A', 'A', ['TABLE', 'VIEW']);

		cache.clearConnectionMetadata('CONN_A');

		expect(cache.getDatabases('CONN_A')).toBeUndefined();
		expect(cache.getTables('CONN_A', 'A.S')).toBeUndefined();
		// Cleared entry falls back to provider defaults rather than cached groups.
		expect(cache.getTypeGroups('CONN_A', 'A')).toEqual(['TABLE', 'VIEW', 'PROCEDURE']);
		expect(cache.getDatabases('CONN_B')).toEqual([expect.objectContaining({ DATABASE: 'B' })]);
		expect(cache.getTables('CONN_B', 'B.S')).toEqual([
			expect.objectContaining({ OBJNAME: 'T2' }),
		]);
	});

	it.each(['db2', 'oracle'] as const)('refreshObjectType works for %s connections', async (kind) => {
		const metadataCache = new MetadataCache({
			globalStorageUri: vscode.Uri.file(`/tmp/refresh-object-type-${kind}`),
		} as vscode.ExtensionContext);
		const connectionManager = {
			getConnectionDatabaseKind: jest.fn(() => kind),
		} as unknown as ConnectionManager;
		const schemaProvider = { refresh: jest.fn() } as unknown as SchemaProvider;
		const synchronizer = new TableDdlSynchronizer(
			{} as vscode.ExtensionContext,
			connectionManager,
			metadataCache,
			schemaProvider,
		);

		await synchronizer.refreshObjectType(`${kind.toUpperCase()}_CONN`, 'TESTDB', 'TABLE');

		expect(metadataCache.getTables(`${kind.toUpperCase()}_CONN`, 'TESTDB.APP')).toEqual([
			expect.objectContaining({ OBJNAME: 'JBL_T', SCHEMA: 'APP', objType: 'TABLE' }),
		]);
		expect(schemaProvider.refresh).toHaveBeenCalled();
	});

	it('refreshSchemaSelection on serverInstance clears connection cache without clearCache', async () => {
		const clearConnectionMetadata = jest.fn();
		const clearCache = jest.fn();
		const refresh = jest.fn();
		const clearConnectionError = jest.fn();
		let handler: ((item?: SchemaItem) => Promise<void>) | undefined;
		(vscode.commands.registerCommand as jest.Mock).mockImplementation(
			(_id: string, fn: (item?: SchemaItem) => Promise<void>) => {
				handler = fn;
				return { dispose: jest.fn() };
			},
		);

		registerRefreshMetadataCommands({
			context: {} as vscode.ExtensionContext,
			connectionManager: {
				getConnectionDatabaseKind: jest.fn(() => 'db2'),
			} as unknown as ConnectionManager,
			metadataCache: {
				clearConnectionMetadata,
				clearCache,
				triggerConnectionPrefetch: jest.fn(),
			},
			schemaProvider: {
				refresh,
				clearConnectionError,
			},
			schemaTreeView: {} as vscode.TreeView<SchemaItem>,
			tableDdlSynchronizer: undefined,
		} as unknown as SchemaCommandsDependencies);

		await handler?.(
			new SchemaItem(
				'MyDb2',
				vscode.TreeItemCollapsibleState.Collapsed,
				'serverInstance',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				'MyDb2',
			),
		);

		expect(clearConnectionMetadata).toHaveBeenCalledWith('MyDb2');
		expect(clearCache).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
	});

	it('shows a dialect-neutral warning when nothing is selected', async () => {
		let handler: ((item?: SchemaItem) => Promise<void>) | undefined;
		(vscode.commands.registerCommand as jest.Mock).mockImplementation(
			(_id: string, fn: (item?: SchemaItem) => Promise<void>) => {
				handler = fn;
				return { dispose: jest.fn() };
			},
		);

		registerRefreshMetadataCommands({
			context: {} as vscode.ExtensionContext,
			connectionManager: {
				getConnectionDatabaseKind: jest.fn(() => 'oracle'),
			} as unknown as ConnectionManager,
			metadataCache: {} as MetadataCache,
			schemaProvider: {} as SchemaProvider,
			schemaTreeView: {} as vscode.TreeView<SchemaItem>,
		} as SchemaCommandsDependencies);

		await handler?.(undefined);

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			'Select a connection, database, object group, or object in the schema tree to refresh.',
		);
		const warning = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0]?.[0] as string;
		expect(warning).not.toMatch(/Netezza/i);
	});
});
