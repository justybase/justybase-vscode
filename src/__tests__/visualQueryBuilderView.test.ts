import * as vscode from 'vscode';
import type { VisualQueryBuilderInboundMessage } from '../contracts/webviews';
import { ConnectionManager } from '../core/connectionManager';
import { buildVisualQueryBuilderDataForAllSchemas } from '../schema/queryBuilderProvider';
import { VisualQueryBuilderView } from '../views/visualQueryBuilderView';

jest.mock('vscode', () => ({
    commands: { executeCommand: jest.fn() },
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: jest.fn(),
        showErrorMessage: jest.fn(),
        showTextDocument: jest.fn().mockResolvedValue(undefined)
    },
    workspace: { openTextDocument: jest.fn() },
    Uri: {
        joinPath: jest.fn((base: { fsPath: string }, ...parts: string[]) => ({
            fsPath: `${base.fsPath}/${parts.join('/')}`
        }))
    },
    ViewColumn: { One: 1 }
}));

jest.mock('../schema/queryBuilderProvider', () => ({
    buildVisualQueryBuilderDataForAllSchemas: jest.fn()
}));

function createPanelMock(): {
    panel: vscode.WebviewPanel;
    getReceiveHandler: () => ((message: VisualQueryBuilderInboundMessage) => Promise<void>) | undefined;
} {
    let receiveHandler: ((message: VisualQueryBuilderInboundMessage) => Promise<void>) | undefined;
    const panel = {
        title: '',
        reveal: jest.fn(),
        dispose: jest.fn(),
        onDidDispose: jest.fn((_handler, _thisArg, disposables) => {
            disposables?.push({ dispose: jest.fn() });
            return { dispose: jest.fn() };
        }),
        webview: {
            cspSource: 'vscode-resource:',
            html: '',
            asWebviewUri: jest.fn((uri: { fsPath: string }) => `webview:${uri.fsPath}`),
            onDidReceiveMessage: jest.fn((handler: (message: VisualQueryBuilderInboundMessage) => Promise<void>) => {
                receiveHandler = handler;
                return { dispose: jest.fn() };
            }),
            postMessage: jest.fn().mockResolvedValue(true)
        }
    } as unknown as vscode.WebviewPanel;
    return { panel, getReceiveHandler: () => receiveHandler };
}

describe('VisualQueryBuilderView', () => {
    const buildAllSchemasMock = buildVisualQueryBuilderDataForAllSchemas as jest.MockedFunction<typeof buildVisualQueryBuilderDataForAllSchemas>;
    const data = {
        database: 'MEMORY',
        schema: 'MAIN',
        allSchemas: ['MAIN'],
        relationships: [],
        tables: [{
            database: 'memory',
            schema: 'MAIN',
            tableName: 'Sales',
            fullName: 'memory.MAIN.Sales',
            objectType: 'VIEW' as const,
            primaryKeyColumns: [],
            columns: []
        }]
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (VisualQueryBuilderView as unknown as { _currentPanel?: undefined })._currentPanel = undefined;
    });

    it('renders a React bootstrap shell and keeps generated File SQL bound to its connection', async () => {
        const { panel, getReceiveHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        const document = { uri: { toString: () => 'untitled:visual-query-builder.sql' } } as vscode.TextDocument;
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);
        const connectionManager = {
            setDocumentConnection: jest.fn().mockResolvedValue(undefined)
        } as unknown as ConnectionManager;

        VisualQueryBuilderView.createOrShow(
            { fsPath: '/test-extension' } as vscode.Uri,
            { extensionUri: { fsPath: '/test-extension' }, workspaceState: { get: jest.fn(), update: jest.fn() } } as unknown as vscode.ExtensionContext,
            connectionManager,
            'File SQL: sales.xlsx',
            ['MAIN'],
            data
        );

        expect(panel.webview.html).toContain('visual-query-builder-root');
        expect(panel.webview.html).toContain('visual-query-builder-payload');
        expect(panel.webview.html).toContain('dist/media/visualQueryBuilder.css');
        expect(panel.webview.html).not.toContain('joinLines');

        const receiveHandler = getReceiveHandler();
        await receiveHandler!({ command: 'openSql', sql: 'SELECT * FROM Sales;' });

        expect(connectionManager.setDocumentConnection).toHaveBeenCalledWith(
            'untitled:visual-query-builder.sql',
            'File SQL: sales.xlsx'
        );
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    });

    it('matches local schema names case-insensitively and reloads only that schema', async () => {
        const { panel, getReceiveHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        buildAllSchemasMock.mockResolvedValue({
            database: 'memory',
            schema: 'main',
            allSchemas: ['main', 'analytics'],
            relationships: [{
                constraintName: 'fk_main',
                fromTable: 'main.orders',
                toTable: 'main.customers',
                fromColumns: ['customer_id'],
                toColumns: ['id'],
                onDelete: 'NO ACTION',
                onUpdate: 'NO ACTION'
            }],
            tables: [
                { database: 'memory', schema: 'main', tableName: 'orders', fullName: 'memory.main.orders', primaryKeyColumns: [], columns: [] },
                { database: 'memory', schema: 'main', tableName: 'customers', fullName: 'memory.main.customers', primaryKeyColumns: [], columns: [] },
                { database: 'memory', schema: 'analytics', tableName: 'events', fullName: 'memory.analytics.events', primaryKeyColumns: [], columns: [] }
            ]
        });
        const connectionManager = {
            setDocumentConnection: jest.fn().mockResolvedValue(undefined),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('duckdb')
        } as unknown as ConnectionManager;

        VisualQueryBuilderView.createOrShow(
            { fsPath: '/test-extension' } as vscode.Uri,
            { extensionUri: { fsPath: '/test-extension' }, workspaceState: { get: jest.fn(), update: jest.fn() } } as unknown as vscode.ExtensionContext,
            connectionManager,
            'DuckDB',
            ['main', 'analytics'],
            data
        );

        await getReceiveHandler()!({ command: 'loadSchema', schema: 'MAIN' });

        const schemaMessage = (panel.webview.postMessage as jest.Mock).mock.calls
            .map(([message]) => message)
            .find(message => message.command === 'schemaData');
        expect(schemaMessage.payload.data.schema).toBe('main');
        expect(schemaMessage.payload.data.tables.map((table: { tableName: string }) => table.tableName))
            .toEqual(['orders', 'customers']);
        expect(schemaMessage.payload.data.relationships).toHaveLength(1);
        expect(schemaMessage.payload.availableSchemas).toEqual(['main', 'analytics']);
    });

    it('persists saveState messages keyed by connection and schema', async () => {
        const { panel, getReceiveHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        const workspaceState = { get: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
        const connectionManager = {
            setDocumentConnection: jest.fn().mockResolvedValue(undefined)
        } as unknown as ConnectionManager;

        VisualQueryBuilderView.createOrShow(
            { fsPath: '/test-extension' } as vscode.Uri,
            { extensionUri: { fsPath: '/test-extension' }, workspaceState } as unknown as vscode.ExtensionContext,
            connectionManager,
            'File SQL: sales.xlsx',
            ['MAIN'],
            data
        );

        const state = {
            placedTables: [{ instanceId: 'T1', tableName: 'Sales', schema: 'MAIN', database: 'memory', fullName: 'memory.MAIN.Sales', alias: 'S1', x: 80, y: 80, selectedColumns: [] }],
            joins: [],
            filterColumns: [],
            clauses: { distinct: false, whereClause: '', groupByClause: '', havingClause: '', orderByClause: '', limitValue: '' },
            searchTerm: ''
        };
        await getReceiveHandler()!({ command: 'saveState', state });

        expect(workspaceState.update).toHaveBeenCalledWith('vqb.state.File SQL: sales.xlsx.MAIN', state);
    });

    it('restores a saved design state into the bootstrap payload', async () => {
        const { panel } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        const savedState = {
            placedTables: [],
            joins: [],
            filterColumns: [{ id: 'F1', tableInstanceId: 'T1', columnName: 'AMOUNT', show: true, aggregate: 'SUM', sort: 'NONE', criteriaRows: ['> 100', '', ''] }],
            clauses: { distinct: false, whereClause: '', groupByClause: '', havingClause: '', orderByClause: '', limitValue: '' },
            searchTerm: ''
        };
        const workspaceState = {
            get: jest.fn().mockReturnValue(savedState),
            update: jest.fn().mockResolvedValue(undefined)
        };
        const connectionManager = {
            setDocumentConnection: jest.fn().mockResolvedValue(undefined)
        } as unknown as ConnectionManager;

        VisualQueryBuilderView.createOrShow(
            { fsPath: '/test-extension' } as vscode.Uri,
            { extensionUri: { fsPath: '/test-extension' }, workspaceState } as unknown as vscode.ExtensionContext,
            connectionManager,
            'File SQL: sales.xlsx',
            ['MAIN'],
            data
        );

        expect(workspaceState.get).toHaveBeenCalledWith('vqb.state.File SQL: sales.xlsx.MAIN');
        expect(panel.webview.html).toContain('aggregate');
    });
});
