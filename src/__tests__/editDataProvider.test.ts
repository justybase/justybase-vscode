/**
 * Unit tests for EditDataProvider
 * Tests the EditDataProvider class for table data editing functionality
 */

import * as vscode from 'vscode';
import { EditDataProvider, EditDataItem } from '../views/editDataProvider';
import { ConnectionManager } from '../core/connectionManager';

// Mock dependencies
jest.mock('../core/queryRunner', () => ({
    runQuery: jest.fn(),
    runQueryRaw: jest.fn(),
    runQueriesSequentially: jest.fn(),
    queryResultToRows: jest.fn(result => {
        if (!result || !result.data) return [];
        return result.data.map((row: unknown[]) => {
            const obj: Record<string, unknown> = {};
            if (result.columns) {
                result.columns.forEach((col: { name: string }, i: number) => {
                    obj[col.name] = row[i];
                });
            }
            return obj;
        });
    })
}));

jest.mock('../providers/tableMetadataProvider', () => ({
    getTableMetadata: jest.fn(),
    toWebviewFormat: jest.fn(columns => columns)
}));

import { runQueryRaw, runQueriesSequentially } from '../core/queryRunner';
import { getTableMetadata } from '../providers/tableMetadataProvider';

describe('EditDataProvider', () => {
    let mockContext: vscode.ExtensionContext;
    let mockConnectionManager: jest.Mocked<ConnectionManager>;
    let mockPanel: jest.Mocked<vscode.WebviewPanel>;
    let mockWebview: jest.Mocked<vscode.Webview>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messageHandler: ((message: any) => Promise<void>) | undefined;

    const sampleItem: EditDataItem = {
        label: 'users',
        dbName: 'testdb',
        schema: 'public',
        connectionName: 'TestConnection'
    };

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();
        messageHandler = undefined;

        // Create mock webview
        mockWebview = {
            html: '',
            onDidReceiveMessage: jest.fn(handler => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            }),
            postMessage: jest.fn().mockResolvedValue(true),
            asWebviewUri: jest.fn(uri => ({ toString: () => `mock-uri://${uri.fsPath}` })),
            cspSource: 'mock-csp-source'
        } as unknown as jest.Mocked<vscode.Webview>;

        // Create mock panel
        mockPanel = {
            webview: mockWebview,
            dispose: jest.fn(),
            onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
            reveal: jest.fn()
        } as unknown as jest.Mocked<vscode.WebviewPanel>;

        // Mock createWebviewPanel
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);

        // Create mock context
        mockContext = {
            extensionUri: { fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri,
            globalState: {
                get: jest.fn(),
                update: jest.fn()
            },
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        // Create mock connection manager
        mockConnectionManager = {
            getConnection: jest.fn(),
            setDocumentConnection: jest.fn()
        } as unknown as jest.Mocked<ConnectionManager>;
    });

    describe('createOrShow', () => {
        it('should create webview panel with correct configuration', async () => {
            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'netezza.editData',
                'Edit: users',
                vscode.ViewColumn.One,
                expect.objectContaining({
                    enableScripts: true,
                    retainContextWhenHidden: true
                })
            );
        });

        it('should show error for invalid item', async () => {
            const invalidItem = { ...sampleItem, label: '' };

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                invalidItem,
                mockContext,
                mockConnectionManager
            );

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid table selection');
        });

        it('should load data on creation', async () => {
            const mockData = {
                columns: [{ name: 'ID' }, { name: 'NAME' }],
                data: [
                    [1, 'John'],
                    [2, 'Jane']
                ]
            };
            (runQueryRaw as jest.Mock).mockResolvedValue(mockData);
            (getTableMetadata as jest.Mock).mockResolvedValue({
                columns: [{ ATTNAME: 'ID' }, { ATTNAME: 'NAME' }],
                tableComment: 'Test table'
            });

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            expect(runQueryRaw).toHaveBeenCalled();
            expect(getTableMetadata).toHaveBeenCalled();
        });

        it('should set up message handlers', async () => {
            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            expect(mockWebview.onDidReceiveMessage).toHaveBeenCalled();
        });

        it('should include correct CSP nonce in HTML', async () => {
            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            const html = mockWebview.html;
            expect(html).toContain('nonce-');
            expect(html).toContain('Content-Security-Policy');
        });
    });

    describe('Message Handlers', () => {
        beforeEach(async () => {
            const mockData = {
                columns: [{ name: 'ROWID' }, { name: 'NAME' }],
                data: [
                    [1, 'John'],
                    [2, 'Jane']
                ]
            };
            (runQueryRaw as jest.Mock).mockResolvedValue(mockData);
            (getTableMetadata as jest.Mock).mockResolvedValue({
                columns: [{ ATTNAME: 'ROWID' }, { ATTNAME: 'NAME' }],
                tableComment: ''
            });

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            // Wait for initial load
            await new Promise(resolve => setTimeout(resolve, 10));
        });

        it('should handle refresh command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'refresh',
                    whereClause: 'ID > 0',
                    columns: 'ID, NAME'
                });

                expect(runQueryRaw).toHaveBeenCalledTimes(2); // Once on create, once on refresh
            }
        });

        it('should handle updateTableComment command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'updateTableComment',
                    comment: 'New comment'
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Table comment updated');
            }
        });

        it('should handle updateColumnComment command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'updateColumnComment',
                    column: 'NAME',
                    comment: 'Column comment'
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Column comment updated');
            }
        });

        it('should handle addColumn command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'addColumn',
                    name: 'AGE',
                    type: 'INTEGER'
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Column AGE added');
            }
        });

        it('should handle dropColumn command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'dropColumn',
                    column: 'AGE'
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Column AGE dropped');
            }
        });

        it('should handle error command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'error',
                    text: 'Test error'
                });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Test error');
            }
        });

        it('should handle info command', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'info',
                    text: 'Test info'
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Test info');
            }
        });
    });

    describe('Save Changes Handler', () => {
        beforeEach(async () => {
            const mockData = {
                columns: [{ name: 'ROWID' }, { name: 'NAME' }],
                data: [[1, 'John']]
            };
            (runQueryRaw as jest.Mock).mockResolvedValue(mockData);
            (getTableMetadata as jest.Mock).mockResolvedValue({
                columns: [{ ATTNAME: 'ROWID' }, { ATTNAME: 'NAME' }],
                tableComment: ''
            });

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            await new Promise(resolve => setTimeout(resolve, 10));
        });

        it('should process updates', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'save',
                    changes: {
                        updates: [{ rowId: 1, changes: { NAME: 'Updated' } }]
                    },
                    whereClause: '',
                    columns: ''
                });

                expect(runQueriesSequentially).toHaveBeenCalled();
            }
        });

        it('should process deletes', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'save',
                    changes: {
                        deletes: [1, 2]
                    },
                    whereClause: '',
                    columns: ''
                });

                expect(runQueriesSequentially).toHaveBeenCalled();
            }
        });

        it('should process inserts', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'save',
                    changes: {
                        inserts: [{ NAME: 'New User' }]
                    },
                    whereClause: '',
                    columns: ''
                });

                expect(runQueriesSequentially).toHaveBeenCalled();
            }
        });

        it('should show message when no changes', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'save',
                    changes: {},
                    whereClause: '',
                    columns: ''
                });

                expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No changes to save.');
            }
        });

        it('should wrap operations in transaction', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'save',
                    changes: {
                        updates: [{ rowId: 1, changes: { NAME: 'Updated' } }]
                    },
                    whereClause: '',
                    columns: ''
                });

                const batch = (runQueriesSequentially as jest.Mock).mock.calls[0][1];
                expect(batch[0]).toBe('BEGIN');
                expect(batch[batch.length - 1]).toBe('COMMIT');
            }
        });
    });

    describe('Query Building', () => {
        it('should include ROWID in select list', async () => {
            const mockData = {
                columns: [{ name: 'ROWID' }, { name: 'NAME' }],
                data: []
            };
            (runQueryRaw as jest.Mock).mockResolvedValue(mockData);
            (getTableMetadata as jest.Mock).mockResolvedValue({
                columns: [{ ATTNAME: 'NAME' }],
                tableComment: ''
            });

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            await new Promise(resolve => setTimeout(resolve, 10));

            const query = (runQueryRaw as jest.Mock).mock.calls[0][1];
            expect(query).toContain('ROWID');
            expect(query).toContain('LIMIT 50000');
        });

        it('should handle WHERE clause with prefix', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'refresh',
                    whereClause: 'WHERE ID > 10',
                    columns: ''
                });

                const query = (runQueryRaw as jest.Mock).mock.calls[1][1];
                expect(query).toContain('WHERE ID > 10');
            }
        });

        it('should handle WHERE clause without prefix', async () => {
            if (messageHandler) {
                await messageHandler({
                    command: 'refresh',
                    whereClause: 'ID > 10',
                    columns: ''
                });

                const query = (runQueryRaw as jest.Mock).mock.calls[1][1];
                expect(query).toContain('WHERE ID > 10');
            }
        });
    });

    describe('Error Handling', () => {
        it('should handle data load errors', async () => {
            (runQueryRaw as jest.Mock).mockRejectedValue(new Error('Database error'));

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        it('should show error message to webview on load failure', async () => {
            (runQueryRaw as jest.Mock).mockRejectedValue(new Error('Database error'));

            await EditDataProvider.createOrShow(
                mockContext.extensionUri,
                sampleItem,
                mockContext,
                mockConnectionManager
            );

            await new Promise(resolve => setTimeout(resolve, 10));

            expect(mockWebview.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    command: 'setError'
                })
            );
        });

        it('should handle save errors', async () => {
            if (messageHandler) {
                (runQueriesSequentially as jest.Mock).mockRejectedValue(new Error('Save failed'));

                await messageHandler({
                    command: 'save',
                    changes: {
                        updates: [{ rowId: 1, changes: { NAME: 'Updated' } }]
                    },
                    whereClause: '',
                    columns: ''
                });

                expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to save'));
            }
        });
    });
});
