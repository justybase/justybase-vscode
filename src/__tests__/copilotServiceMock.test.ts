
import * as vscode from 'vscode';
import { CopilotService } from '../services/copilotService';
import { ConnectionManager } from '../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
    getRequiredDatabaseDdlProvider
} from '../core/connectionFactory';
import { MetadataCache } from '../metadataCache';
import { MockNzConnection } from '../__mocks__/mockNzConnection';
import { MockDataFactory } from '../__mocks__/mockDataFactories';

// Mock types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockType = any;

// Mock vscode
jest.mock('vscode', () => {
    // EventEmitter mock class defined inline
    class MockEventEmitter {
        private _listeners: ((e: unknown) => void)[] = [];
        event = (listener: (e: unknown) => void) => {
            this._listeners.push(listener);
            return { dispose: () => { const index = this._listeners.indexOf(listener); if (index !== -1) { this._listeners.splice(index, 1); } } };
        };
        fire(data: unknown): void { this._listeners.forEach((listener) => listener(data)); }
        dispose(): void { this._listeners = []; }
    }
    
    return {
        Uri: { parse: jest.fn() },
        window: {
            activeTextEditor: undefined,
            createStatusBarItem: jest.fn().mockReturnValue({
                show: jest.fn(),
                hide: jest.fn(),
                text: '',
                tooltip: '',
                command: ''
            }),
            showWarningMessage: jest.fn(),
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showQuickPick: jest.fn()
        },
        commands: {
            executeCommand: jest.fn()
        },
        workspace: {
            getConfiguration: jest.fn().mockReturnValue({
                get: jest.fn()
            })
        },
        Range: jest.fn(),
        StatusBarAlignment: { Right: 1 },
        lm: {
            selectChatModels: jest.fn().mockResolvedValue([])
        },
        EventEmitter: MockEventEmitter
    };
}, { virtual: true });

jest.mock('../core/connectionFactory', () => {
    const actual = jest.requireActual('../core/connectionFactory');
    return {
        ...actual,
        createConnectedDatabaseConnectionFromDetails: jest.fn(),
        executeDatabaseQuery: jest.fn(),
        getDatabaseMetadataProvider: jest.fn().mockReturnValue({
            buildColumnsWithKeysQuery: jest.fn().mockReturnValue('SELECT * FROM _V_RELATION_COLUMN')
        }),
        getRequiredDatabaseDdlProvider: jest.fn()
    };
});

describe('CopilotService with Mock DB', () => {
    let service: CopilotService;
    let mockContext: MockType;
    let mockCache: MockType;
    let mockConnManager: MockType;
    let mockDbConnection: MockNzConnection;
    let mockDdlProvider: { buildFindTableSchemaQuery: jest.Mock; generateTableDDL: jest.Mock };

    beforeEach(() => {
        // Setup mocks
        mockContext = {
            extensionUri: {},
            globalState: {
                get: jest.fn(),
                update: jest.fn()
            },
            workspaceState: {
                get: jest.fn(),
                update: jest.fn()
            }
        };

        mockCache = {};

        mockConnManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
            getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
            getDocumentConnection: jest.fn().mockReturnValue('test-connection'),
            getConnection: jest.fn().mockResolvedValue({
                host: 'host',
                database: 'TEST_DB',
                user: 'user',
                password: 'password',
                dbType: 'netezza'
            }),
            getCurrentDatabase: jest.fn().mockResolvedValue('TEST_DB')
        };

        // Setup mock DB connection
        mockDbConnection = new MockNzConnection();
        mockDdlProvider = {
            buildFindTableSchemaQuery: jest.fn().mockReturnValue('SELECT SCHEMA FROM _V_OBJECT_DATA'),
            generateTableDDL: jest.fn().mockResolvedValue('CREATE TABLE MOCKED_TABLE (COL1 INT);')
        };
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(mockDbConnection);
        (executeDatabaseQuery as jest.Mock).mockResolvedValue([{ SCHEMA: 'PUBLIC' }]);
        (getRequiredDatabaseDdlProvider as jest.Mock).mockReturnValue(mockDdlProvider);

        service = new CopilotService(
            mockConnManager as ConnectionManager,
            mockContext as vscode.ExtensionContext,
            mockCache as MetadataCache
        );
    });

    // extractTableReferences logic moved to TableReferenceExtractor and tested separately


    describe('gatherContext', () => {
        it('should gather DDL context for selected SQL', async () => {
            // Mock active editor
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM MY_TABLE'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = mockEditor;

            // Mock finding schema - return PUBLIC
            mockDbConnection.setMockData('SELECT 1', [MockDataFactory.createObjectDataRow('MY_TABLE', 'PUBLIC', 'TEST_DB', 'TABLE')]);

            const context = await service.gatherContext();

            expect(context.selectedSql).toBe('SELECT * FROM MY_TABLE');
            expect(mockDdlProvider.generateTableDDL).toHaveBeenCalled();
            expect(context.ddlContext).toContain('CREATE TABLE MOCKED_TABLE');
        });
    });
});
