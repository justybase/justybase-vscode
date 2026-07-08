import * as vscode from 'vscode';
import { KeyInfo, ProcedureComparisonResult, TableComparisonResult } from '../schema/schemaComparer';
import { SchemaCompareView } from '../views/schemaCompareView';

describe('SchemaCompareView', () => {
    let mockPanel: vscode.WebviewPanel;
    let disposeHandler: (() => void) | undefined;
    let extensionUri: vscode.Uri;

    const tableResult: TableComparisonResult = {
        source: { database: 'SRC_DB', schema: 'PUBLIC', name: 'CUSTOMERS' },
        target: { database: 'TRG_DB', schema: 'PUBLIC', name: 'CUSTOMERS' },
        columnDiffs: [
            {
                name: 'ID',
                status: 'unchanged',
                sourceColumn: {
                    name: 'ID',
                    description: null,
                    fullTypeName: 'INTEGER',
                    notNull: true,
                    defaultValue: null
                },
                targetColumn: {
                    name: 'ID',
                    description: null,
                    fullTypeName: 'INTEGER',
                    notNull: true,
                    defaultValue: null
                },
                changes: []
            },
            {
                name: 'EMAIL',
                status: 'modified',
                sourceColumn: {
                    name: 'EMAIL',
                    description: null,
                    fullTypeName: 'VARCHAR(100)',
                    notNull: false,
                    defaultValue: null
                },
                targetColumn: {
                    name: 'EMAIL',
                    description: null,
                    fullTypeName: 'VARCHAR(255)',
                    notNull: false,
                    defaultValue: null
                },
                changes: ['Type: VARCHAR(100) → VARCHAR(255)']
            }
        ],
        keyDiffs: [
            {
                name: 'PK_CUSTOMERS',
                status: 'modified',
                sourceKey: {
                    type: 'PRIMARY KEY',
                    typeChar: 'p',
                    columns: ['ID'],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: 'NO ACTION',
                    deleteType: 'NO ACTION'
                } as KeyInfo,
                targetKey: {
                    type: 'PRIMARY KEY',
                    typeChar: 'p',
                    columns: ['ID', 'EMAIL'],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: 'NO ACTION',
                    deleteType: 'NO ACTION'
                } as KeyInfo,
                changes: ['Columns: (ID) → (ID, EMAIL)']
            }
        ],
        distributionMatch: false,
        sourceDistribution: ['ID'],
        targetDistribution: ['EMAIL'],
        organizationMatch: true,
        sourceOrganization: ['EMAIL'],
        targetOrganization: ['EMAIL'],
        summary: {
            columnsAdded: 0,
            columnsRemoved: 0,
            columnsModified: 1,
            columnsUnchanged: 1,
            keysAdded: 0,
            keysRemoved: 0,
            keysModified: 1
        }
    };

    const procedureResult: ProcedureComparisonResult = {
        source: { database: 'SRC_DB', schema: 'PUBLIC', name: 'PROC_A' },
        target: { database: 'TRG_DB', schema: 'PUBLIC', name: 'PROC_A' },
        argumentsMatch: false,
        sourceArguments: 'P_ID INT',
        targetArguments: 'P_ID BIGINT',
        returnsMatch: false,
        sourceReturns: 'INT',
        targetReturns: 'VARCHAR(10)',
        executeAsOwnerMatch: false,
        sourceExecuteAsOwner: true,
        targetExecuteAsOwner: false,
        sourceMatch: false,
        sourceCode: 'BEGIN\nRETURN <unsafe>;\nEND;',
        targetCode: 'BEGIN\nRETURN 1;\nEND;',
        sourceDiff: ['- RETURN <unsafe>;', '+ RETURN 1;', '  END;']
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (SchemaCompareView as unknown as { currentPanel?: SchemaCompareView }).currentPanel = undefined;

        extensionUri = {
            fsPath: 'D:\\extension',
            toString: () => 'file:///D:/extension'
        } as vscode.Uri;

        mockPanel = {
            webview: {
                html: '',
                postMessage: jest.fn(),
                asWebviewUri: jest.fn((uri: vscode.Uri) => uri)
            },
            title: '',
            reveal: jest.fn(),
            dispose: jest.fn(),
            onDidDispose: jest.fn((handler: () => void) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            })
        } as unknown as vscode.WebviewPanel;

        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(mockPanel);
    });

    afterEach(() => {
        disposeHandler = undefined;
        (SchemaCompareView as unknown as { currentPanel?: SchemaCompareView }).currentPanel = undefined;
    });

    it('creates table comparison panel with expected HTML content', () => {
        SchemaCompareView.createOrShow(extensionUri, tableResult, 'table');

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'netezza.schemaCompare',
            'Schema Comparison',
            expect.anything(),
            expect.objectContaining({
                enableScripts: true
            })
        );
        expect(mockPanel.title).toContain('CUSTOMERS');
        expect(mockPanel.webview.html).toContain('Table Structure Comparison');
        expect(mockPanel.webview.html).toContain('Type: VARCHAR(100) → VARCHAR(255)');
        expect(mockPanel.webview.html).toContain('❌ Different');
        expect(mockPanel.webview.html).toContain('✅ Match');
    });

    it('reuses existing panel and updates to procedure comparison', () => {
        SchemaCompareView.createOrShow(extensionUri, tableResult, 'table');
        (vscode.window.createWebviewPanel as jest.Mock).mockClear();

        SchemaCompareView.createOrShow(extensionUri, procedureResult, 'procedure');

        expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
        expect(mockPanel.reveal).toHaveBeenCalled();
        expect(mockPanel.title).toContain('PROC_A');
        expect(mockPanel.webview.html).toContain('Procedure Comparison');
        expect(mockPanel.webview.html).toContain('diff-removed');
        expect(mockPanel.webview.html).toContain('diff-added');
        expect(mockPanel.webview.html).toContain('&lt;unsafe&gt;');
    });

    it('renders identical procedure source without diff block', () => {
        const identicalResult: ProcedureComparisonResult = {
            ...procedureResult,
            sourceMatch: true,
            sourceDiff: [],
            sourceCode: 'BEGIN\nRETURN 1;\nEND;',
            targetCode: 'BEGIN\nRETURN 1;\nEND;',
            argumentsMatch: true,
            returnsMatch: true,
            executeAsOwnerMatch: true
        };

        SchemaCompareView.createOrShow(extensionUri, identicalResult, 'procedure');

        expect(mockPanel.webview.html).toContain('Source Code ✅ Identical');
        expect(mockPanel.webview.html).toContain('<pre>BEGIN');
    });

    it('disposes panel and clears singleton reference', () => {
        SchemaCompareView.createOrShow(extensionUri, tableResult, 'table');
        const viewInstance = (SchemaCompareView as unknown as { currentPanel?: SchemaCompareView }).currentPanel;

        expect(viewInstance).toBeDefined();
        disposeHandler?.();

        expect(mockPanel.dispose).toHaveBeenCalled();
        expect((SchemaCompareView as unknown as { currentPanel?: SchemaCompareView }).currentPanel).toBeUndefined();
    });
});
