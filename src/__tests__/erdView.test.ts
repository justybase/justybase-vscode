/**
 * Unit tests for ERDView
 * Tests Entity Relationship Diagram webview panel, table layout, and relationship rendering
 */

import * as vscode from 'vscode';
import { ERDView } from '../views/erdView';
import type { ERDData } from '../schema/erdProvider';

describe('ERDView', () => {
    let mockExtensionUri: vscode.Uri;
    let mockWebviewPanel: vscode.WebviewPanel;
    let disposeHandler: (() => void) | null = null;

    // Sample ERD data for testing - using type casting since ERDView only uses subset of fields
    const sampleErdData = {
        database: 'TESTDB',
        schema: 'PUBLIC',
        tables: [
            {
                fullName: 'PUBLIC.USERS',
                tableName: 'USERS',
                database: 'TESTDB',
                schema: 'PUBLIC',
                primaryKeyColumns: ['ID'],
                columns: [
                    { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                    { name: 'NAME', dataType: 'VARCHAR(100)', isPrimaryKey: false, isForeignKey: false },
                    { name: 'EMAIL', dataType: 'VARCHAR(255)', isPrimaryKey: false, isForeignKey: false }
                ]
            },
            {
                fullName: 'PUBLIC.ORDERS',
                tableName: 'ORDERS',
                database: 'TESTDB',
                schema: 'PUBLIC',
                primaryKeyColumns: ['ID'],
                columns: [
                    { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                    { name: 'USER_ID', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: true },
                    { name: 'AMOUNT', dataType: 'DECIMAL(10,2)', isPrimaryKey: false, isForeignKey: false },
                    { name: 'ORDER_DATE', dataType: 'DATE', isPrimaryKey: false, isForeignKey: false }
                ]
            },
            {
                fullName: 'PUBLIC.PRODUCTS',
                tableName: 'PRODUCTS',
                database: 'TESTDB',
                schema: 'PUBLIC',
                primaryKeyColumns: ['ID'],
                columns: [
                    { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                    { name: 'NAME', dataType: 'VARCHAR(200)', isPrimaryKey: false, isForeignKey: false },
                    { name: 'PRICE', dataType: 'DECIMAL(10,2)', isPrimaryKey: false, isForeignKey: false }
                ]
            }
        ],
        relationships: [
            {
                constraintName: 'FK_ORDERS_USER',
                fromTable: 'PUBLIC.ORDERS',
                fromColumns: ['USER_ID'],
                toTable: 'PUBLIC.USERS',
                toColumns: ['ID'],
                onDelete: 'CASCADE',
                onUpdate: 'NO ACTION'
            }
        ]
    } as ERDData;

    beforeEach(() => {
        jest.clearAllMocks();

        // Reset static state
        (ERDView as unknown as { currentPanel: undefined }).currentPanel = undefined;

        mockExtensionUri = {
            fsPath: '/test',
            toString: () => 'file:///test'
        } as vscode.Uri;

        // Mock webview panel
        mockWebviewPanel = {
            webview: {
                html: '',
                onDidReceiveMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
                postMessage: jest.fn().mockResolvedValue(true),
                asWebviewUri: jest.fn((uri) => ({
                    toString: () => `webview-uri://${uri.fsPath}`
                }))
            },
            viewType: 'netezza.erdView',
            title: 'ERD: TESTDB.PUBLIC',
            visible: true,
            active: true,
            onDidDispose: jest.fn((handler) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            }),
            onDidChangeViewState: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            reveal: jest.fn(),
            dispose: jest.fn()
        } as unknown as vscode.WebviewPanel;

        // Mock window.createWebviewPanel
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockWebviewPanel);
    });

    afterEach(() => {
        (ERDView as unknown as { currentPanel: undefined }).currentPanel = undefined;
        disposeHandler = null;
    });

    describe('createOrShow', () => {
        it('should create new panel when none exists', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                'netezza.erdView',
                'ERD: TESTDB.PUBLIC',
                expect.any(Number),
                expect.objectContaining({
                    enableScripts: true
                })
            );
            expect(ERDView.currentPanel).toBeDefined();
        });

        it('should reveal existing panel instead of creating new one', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);
            const firstCallCount = (vscode.window.createWebviewPanel as jest.Mock).mock.calls.length;

            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            expect((vscode.window.createWebviewPanel as jest.Mock).mock.calls.length).toBe(firstCallCount);
            expect(mockWebviewPanel.reveal).toHaveBeenCalled();
        });

        it('should update ERD data when revealing existing panel', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            const newData: ERDData = {
                database: 'NEWDB',
                schema: 'NEWSCHEMA',
                tables: [],
                relationships: []
            };

            ERDView.createOrShow(mockExtensionUri, newData);

            // Panel title should be updated to reflect new data
            // Note: We can verify the HTML was updated by checking it contains new schema name
            expect(mockWebviewPanel.webview.html).toContain('NEWDB.NEWSCHEMA');
        });

        it('should set panel title with database and schema', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            // Check the panel was created with correct title
            expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
                expect.anything(),
                'ERD: TESTDB.PUBLIC',
                expect.anything(),
                expect.anything()
            );
        });
    });

    describe('webview shell', () => {
        beforeEach(() => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);
        });

        it('should include page header with title', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('Entity Relationship Diagram');
        });

        it('should display database and schema in the title', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('TESTDB.PUBLIC');
        });

        it('should display table count', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="tableCount">3');
            expect(html).toContain('>tables</span>');
        });

        it('should display relationship count', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="relationshipCount">1');
            expect(html).toContain('>relationships</span>');
        });

        it('should include the interactive toolbar and inspector', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="erdSearch"');
            expect(html).toContain('id="autoArrangeButton"');
            expect(html).toContain('id="fitViewButton"');
            expect(html).toContain('id="exportButton"');
            expect(html).toContain('id="erdInspector"');
        });

        it('should include the canvas and relationship SVG layers', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('id="erdViewport"');
            expect(html).toContain('id="tableLayer"');
            expect(html).toContain('id="relationshipsSvg"');
        });

        it('should pass the complete ERD payload to the webview renderer', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('window.__NETEZZA_ERD_DATA__');
            expect(html).toContain('PUBLIC.USERS');
            expect(html).toContain('VARCHAR(100)');
            expect(html).toContain('FK_ORDERS_USER');
        });

        it('should load external renderer and styles with a CSP', () => {
            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('erdView.css');
            expect(html).toContain('erdView.js');
            expect(html).toContain('Content-Security-Policy');
            expect(html).toContain('nonce=');
        });
    });

    describe('empty states', () => {
        it('should pass a schema without relationships to the renderer', () => {
            const noRelationshipsData = {
                database: 'TESTDB',
                schema: 'PUBLIC',
                tables: [
                    {
                        fullName: 'PUBLIC.STANDALONE',
                        tableName: 'STANDALONE',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['ID'],
                        columns: [
                            { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false }
                        ]
                    }
                ],
                relationships: []
            } as ERDData;

            ERDView.createOrShow(mockExtensionUri, noRelationshipsData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('"relationships":[]');
            expect(html).toContain('id="canvasEmpty"');
            expect(html).toContain('id="inspectorContent"');
        });

        it('should render the empty schema shell without table markup', () => {
            const noRelationshipsData: ERDData = {
                database: 'TESTDB',
                schema: 'PUBLIC',
                tables: [],
                relationships: []
            };

            ERDView.createOrShow(mockExtensionUri, noRelationshipsData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('"tables":[]');
            expect(html).toContain('No tables were found for this schema');
        });
    });

    describe('layout and column visibility contract', () => {
        it('should include all tables in the graph payload', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('PUBLIC.USERS');
            expect(html).toContain('PUBLIC.ORDERS');
            expect(html).toContain('PUBLIC.PRODUCTS');
        });

        it('should pass all columns for scrollable table cards', () => {
            const manyColumnsData = {
                database: 'TESTDB',
                schema: 'PUBLIC',
                tables: [
                    {
                        fullName: 'PUBLIC.WIDE_TABLE',
                        tableName: 'WIDE_TABLE',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['COL_1'],
                        columns: Array.from({ length: 15 }, (_, i) => ({
                            name: `COL_${i + 1}`,
                            dataType: 'VARCHAR(50)',
                            isPrimaryKey: i === 0,
                            isForeignKey: false
                        }))
                    }
                ],
                relationships: []
            } as ERDData;

            ERDView.createOrShow(mockExtensionUri, manyColumnsData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('COL_1');
            expect(html).toContain('COL_10');
            expect(html).toContain('COL_11');
            expect(html).toContain('COL_15');
            expect(html).not.toContain('... and 5 more');
        });
    });

    describe('relationship data payload', () => {
        it('should serialize relationships for the browser renderer', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('"relationships":[{');
            expect(html).toContain('FK_ORDERS_USER');
        });
    });

    describe('webview resources', () => {
        it('should reference the ERD renderer resources', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('webview-uri:///test/media/erdView.css');
            expect(html).toContain('webview-uri:///test/dist/media/erdView.js');
        });
    });

    describe('dispose', () => {
        it('should clean up panel reference on dispose', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);
            expect(ERDView.currentPanel).toBeDefined();

            disposeHandler!();

            expect(ERDView.currentPanel).toBeUndefined();
        });

        it('should call panel dispose', () => {
            ERDView.createOrShow(mockExtensionUri, sampleErdData);
            const panel = ERDView.currentPanel;

            panel!.dispose();

            expect(mockWebviewPanel.dispose).toHaveBeenCalled();
        });
    });

    describe('complex ERD scenarios', () => {
        it('should handle multiple relationships between same tables', () => {
            const multiRelData = {
                database: 'TESTDB',
                schema: 'PUBLIC',
                tables: [
                    {
                        fullName: 'PUBLIC.ORDERS',
                        tableName: 'ORDERS',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['ID'],
                        columns: [
                            { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                            { name: 'SHIPPING_ADDRESS_ID', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: true },
                            { name: 'BILLING_ADDRESS_ID', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: true }
                        ]
                    },
                    {
                        fullName: 'PUBLIC.ADDRESSES',
                        tableName: 'ADDRESSES',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['ID'],
                        columns: [
                            { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                            { name: 'STREET', dataType: 'VARCHAR(200)', isPrimaryKey: false, isForeignKey: false }
                        ]
                    }
                ],
                relationships: [
                    {
                        constraintName: 'FK_ORDERS_SHIPPING',
                        fromTable: 'PUBLIC.ORDERS',
                        fromColumns: ['SHIPPING_ADDRESS_ID'],
                        toTable: 'PUBLIC.ADDRESSES',
                        toColumns: ['ID'],
                        onDelete: 'SET NULL',
                        onUpdate: 'NO ACTION'
                    },
                    {
                        constraintName: 'FK_ORDERS_BILLING',
                        fromTable: 'PUBLIC.ORDERS',
                        fromColumns: ['BILLING_ADDRESS_ID'],
                        toTable: 'PUBLIC.ADDRESSES',
                        toColumns: ['ID'],
                        onDelete: 'SET NULL',
                        onUpdate: 'NO ACTION'
                    }
                ]
            } as ERDData;

            ERDView.createOrShow(mockExtensionUri, multiRelData);

            const html = mockWebviewPanel.webview.html;
            expect(html).toContain('FK_ORDERS_SHIPPING');
            expect(html).toContain('FK_ORDERS_BILLING');
            expect(html).toContain('id="relationshipCount">2');
        });

        it('should handle composite foreign keys', () => {
            const compositeData = {
                database: 'TESTDB',
                schema: 'PUBLIC',
                tables: [
                    {
                        fullName: 'PUBLIC.ORDER_ITEMS',
                        tableName: 'ORDER_ITEMS',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['ORDER_ID', 'LINE_NUM'],
                        columns: [
                            { name: 'ORDER_ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: true },
                            { name: 'LINE_NUM', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false }
                        ]
                    },
                    {
                        fullName: 'PUBLIC.ORDERS',
                        tableName: 'ORDERS',
                        database: 'TESTDB',
                        schema: 'PUBLIC',
                        primaryKeyColumns: ['ID'],
                        columns: [
                            { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false }
                        ]
                    }
                ],
                relationships: [
                    {
                        constraintName: 'FK_ORDER_ITEMS_ORDER',
                        fromTable: 'PUBLIC.ORDER_ITEMS',
                        fromColumns: ['ORDER_ID'],
                        toTable: 'PUBLIC.ORDERS',
                        toColumns: ['ID'],
                        onDelete: 'CASCADE',
                        onUpdate: 'NO ACTION'
                    }
                ]
            } as ERDData;

            ERDView.createOrShow(mockExtensionUri, compositeData);

            const html = mockWebviewPanel.webview.html;
            // Column marked as both PK and FK
            expect(html).toContain('ORDER_ID');
        });
    });
});
