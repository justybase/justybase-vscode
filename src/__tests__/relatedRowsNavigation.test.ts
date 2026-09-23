import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryExecutionResultPanel, QueryExecutionLease } from '../commands/query/queryExecutionGate';
import type { ResultStateManager } from '../state/resultStateManager';
import type { ResultSet } from '../types';
import type { ColumnMetadata } from '../metadata/types';
import { getCachedColumnsFromMetadataCacheAsync } from '../metadata/columnCacheLookup';
import { cancelQueryByUri, runQueryRaw } from '../core/queryRunner';
import { markQueryExecutionCancelling, tryAcquireQueryExecution } from '../commands/query/queryExecutionGate';
import { openRelatedRowsFromCell, type RelatedRowsNavigationHost } from '../results/relatedRowsNavigation';

jest.mock('vscode', () => ({
    window: {
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn(),
        withProgress: jest.fn(),
    },
    workspace: { textDocuments: [] },
    ProgressLocation: { Notification: 15 },
}), { virtual: true });

jest.mock('../metadata/columnCacheLookup', () => ({
    getCachedColumnsFromMetadataCacheAsync: jest.fn(),
}));
jest.mock('../core/queryRunner', () => ({
    cancelQueryByUri: jest.fn().mockResolvedValue(undefined),
    runQueryRaw: jest.fn(),
}));
jest.mock('../commands/query/queryExecutionGate', () => ({
    markQueryExecutionCancelling: jest.fn(),
    tryAcquireQueryExecution: jest.fn(),
}));
jest.mock('../commands/query/queryExecutionRecovery', () => ({
    createQueryExecutionRecovery: jest.fn(() => ({})),
}));

const sourceUri = 'file:///queries/orders.sql';
const sourceColumns: ColumnMetadata[] = [
    { ATTNAME: 'USER_ID', FORMAT_TYPE: 'INTEGER', isFk: true },
];
const userColumns: ColumnMetadata[] = [
    { ATTNAME: 'USER_ID', FORMAT_TYPE: 'INTEGER', isPk: true },
];

function makeHarness(candidateTables = ['USERS', 'USER_ARCHIVE']): {
    host: RelatedRowsNavigationHost;
    stateManager: {
        resultsMap: Map<string, ResultSet[]>;
        startAuxiliaryExecution: jest.Mock;
        appendAuxiliaryResultSet: jest.Mock;
        finishAuxiliaryExecution: jest.Mock;
    };
    logs: jest.Mock;
    updateWebview: jest.Mock;
} {
    const resultSet = {
        isEditable: true,
        storageMode: 'memory',
        editSource: { db: 'SALES', schema: 'PUBLIC', table: 'ORDERS' },
        columns: [{ name: 'USER_ID', type: 'INTEGER' }],
        data: [[41]],
    } as ResultSet;
    const stateManager = {
        resultsMap: new Map([[sourceUri, [resultSet]]]),
        startAuxiliaryExecution: jest.fn(() => true),
        appendAuxiliaryResultSet: jest.fn(),
        finishAuxiliaryExecution: jest.fn(),
    };
    const metadataCache = {
        getTablesAllSchemas: jest.fn(() => candidateTables.map((table) => ({ TABLENAME: table, SCHEMA: 'PUBLIC' }))),
    };
    const connectionManager = {
        getConnectionDatabaseKind: jest.fn(() => 'postgresql'),
        getEffectiveDatabase: jest.fn(async () => 'SALES'),
        getEffectiveSchema: jest.fn(async () => 'PUBLIC'),
        getMetadataCache: jest.fn(() => metadataCache),
    };
    const logs = jest.fn();
    const updateWebview = jest.fn();
    const host = {
        connectionManager: connectionManager as unknown as ConnectionManager,
        context: {} as never,
        stateManager: stateManager as unknown as ResultStateManager,
        executionPanel: { log: logs, getActiveSource: () => sourceUri } as QueryExecutionResultPanel,
        resolveConnectionName: () => 'warehouse',
        setActiveSource: jest.fn(),
        log: logs,
        updateWebview,
    };
    return { host, stateManager, logs, updateWebview };
}

function setupSuccessfulQueryMocks(): {
    lease: QueryExecutionLease & { dispose: jest.Mock; markRunning: jest.Mock; markCancelling: jest.Mock };
    withProgress: jest.Mock;
} {
    const lease = {
        executionId: 'execution-1',
        sourceUri,
        sourceKey: sourceUri,
        origin: 'Related rows',
        isCurrent: jest.fn(() => true),
        markRunning: jest.fn(),
        markCancelling: jest.fn(),
        setRecovery: jest.fn(),
        dispose: jest.fn(),
    } as unknown as QueryExecutionLease & {
        dispose: jest.Mock;
        markRunning: jest.Mock;
        markCancelling: jest.Mock;
    };
    (tryAcquireQueryExecution as jest.Mock).mockResolvedValue(lease);
    (runQueryRaw as jest.Mock).mockResolvedValue({
        columns: [{ name: 'USER_ID', type: 'INTEGER' }],
        data: [[41], [42]],
    });
    const withProgress = vscode.window.withProgress as jest.Mock;
    withProgress.mockImplementation(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
        const token = {
            onCancellationRequested: () => ({ dispose: jest.fn() }),
        };
        return task({ report: jest.fn() }, token);
    });
    return { lease, withProgress };
}

describe('openRelatedRowsFromCell', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getCachedColumnsFromMetadataCacheAsync as jest.Mock).mockImplementation(async (
            _cache: unknown,
            _connection: string,
            _database: string,
            _schema: string | undefined,
            table: string,
        ) => table === 'ORDERS' ? sourceColumns : userColumns);
    });

    it('runs a bounded related query and appends a separate result tab', async () => {
        const { host, stateManager, logs, updateWebview } = makeHarness();
        const { lease, withProgress } = setupSuccessfulQueryMocks();
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: Array<{ candidate: unknown }>) => items[0]);

        await openRelatedRowsFromCell(host, sourceUri, 0, 0, 0);

        expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
        expect(tryAcquireQueryExecution).toHaveBeenCalledWith(
            sourceUri,
            host.executionPanel,
            expect.objectContaining({ origin: 'Related rows' }),
        );
        expect(withProgress).toHaveBeenCalledTimes(1);
        expect(runQueryRaw).toHaveBeenCalledWith(expect.objectContaining({
            connectionName: 'warehouse',
            maxRows: 100,
            timeoutSeconds: 60,
            isUserQuery: false,
        }));
        expect(stateManager.appendAuxiliaryResultSet).toHaveBeenCalledWith(sourceUri, expect.objectContaining({
            name: 'Related: USERS.USER_ID',
            data: [[41], [42]],
            isEditable: false,
            sql: undefined,
            refreshSql: undefined,
        }));
        expect(stateManager.finishAuxiliaryExecution).toHaveBeenCalledWith(sourceUri);
        expect(lease.markRunning).toHaveBeenCalledTimes(1);
        expect(lease.dispose).toHaveBeenCalledTimes(1);
        expect(logs).toHaveBeenCalledWith(sourceUri, 'Loaded 2 related row(s) from USERS.');
        expect(updateWebview).toHaveBeenCalledTimes(1);
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('reports missing execution context and invalid source cells without querying', async () => {
        const emptyHost = makeHarness().host;
        emptyHost.connectionManager = undefined;
        emptyHost.context = undefined;
        await openRelatedRowsFromCell(emptyHost, sourceUri, 0, 0, 0);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('not available'));

        jest.clearAllMocks();
        const { host, stateManager } = makeHarness();
        const row = stateManager.resultsMap.get(sourceUri)?.[0];
        if (row) row.isEditable = false;
        await openRelatedRowsFromCell(host, sourceUri, 0, 0, 0);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('direct table result'));
        expect(getCachedColumnsFromMetadataCacheAsync).not.toHaveBeenCalled();
        expect(runQueryRaw).not.toHaveBeenCalled();
    });

    it('explains when metadata contains no matching related table', async () => {
        const { host } = makeHarness(['UNRELATED']);
        (getCachedColumnsFromMetadataCacheAsync as jest.Mock).mockImplementation(async (
            _cache: unknown,
            _connection: string,
            _database: string,
            _schema: string | undefined,
            table: string,
        ) => table === 'ORDERS' ? sourceColumns : [{ ATTNAME: 'ACCOUNT_ID', FORMAT_TYPE: 'INTEGER' }]);

        await openRelatedRowsFromCell(host, sourceUri, 0, 0, 0);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            'No related table was found in the loaded metadata.',
        );
        expect(tryAcquireQueryExecution).not.toHaveBeenCalled();
    });

    it('finishes and refreshes the panel when a running related query is cancelled', async () => {
        const { host, stateManager, logs, updateWebview } = makeHarness(['USERS']);
        const { lease } = setupSuccessfulQueryMocks();
        (vscode.window.withProgress as jest.Mock).mockImplementation(async (
            _options: unknown,
            task: (progress: unknown, token: unknown) => Promise<unknown>,
        ) => task({ report: jest.fn() }, {
            onCancellationRequested: (listener: () => void) => {
                listener();
                return { dispose: jest.fn() };
            },
        }));

        await openRelatedRowsFromCell(host, sourceUri, 0, 0, 0);

        expect(lease.markCancelling).toHaveBeenCalledTimes(1);
        expect(markQueryExecutionCancelling).toHaveBeenCalledWith(sourceUri);
        expect(cancelQueryByUri).toHaveBeenCalledWith(sourceUri);
        expect(logs).toHaveBeenCalledWith(sourceUri, 'Related-row query cancelled.');
        expect(stateManager.appendAuxiliaryResultSet).not.toHaveBeenCalled();
        expect(stateManager.finishAuxiliaryExecution).toHaveBeenCalledWith(sourceUri);
        expect(updateWebview).toHaveBeenCalledTimes(1);
    });
});
