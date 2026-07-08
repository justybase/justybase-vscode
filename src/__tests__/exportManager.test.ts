import { ExportManager, ExcelExportMetadata } from '../export/exportManager';
import { ResultStateManager } from '../state/resultStateManager';
import { ResultSet } from '../types';

// Mock vscode
jest.mock(
    'vscode',
    () => ({
        EventEmitter: jest.fn().mockImplementation(() => ({
            event: jest.fn(),
            fire: jest.fn()
        })),
        window: {
            showSaveDialog: jest.fn(),
            showQuickPick: jest.fn(),
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            withProgress: jest.fn((_options, task) => task({ report: jest.fn() }))
        },
        workspace: {
            getConfiguration: jest.fn(() => ({
                get: jest.fn((_key, defaultValue) => defaultValue)
            })),
            fs: {
                writeFile: jest.fn().mockResolvedValue(undefined)
            }
        },
        env: {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(undefined)
            },
            openExternal: jest.fn().mockResolvedValue(true)
        },
        Uri: {
            file: jest.fn(path => ({ fsPath: path })),
            joinPath: jest.fn()
        },
        commands: {
            executeCommand: jest.fn().mockResolvedValue(undefined)
        },
        ProgressLocation: {
            Notification: 1
        }
    }),
    { virtual: true }
);

// Mock dependencies
jest.mock('../export/resultExporter', () => ({
    exportResultSetToFile: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../export/xlsbExporter', () => ({
    exportStructuredToXlsb: jest.fn().mockResolvedValue(undefined),
    copyFileToClipboard: jest.fn().mockResolvedValue(true)
}));

jest.mock('../export/xlsxExporter', () => ({
    exportStructuredToXlsx: jest.fn().mockResolvedValue(undefined)
}));

import * as vscode from 'vscode';
import { exportResultSetToFile } from '../export/resultExporter';
import { exportStructuredToXlsb } from '../export/xlsbExporter';
import { exportStructuredToXlsx } from '../export/xlsxExporter';

describe('ExportManager', () => {
    let manager: ExportManager;
    let resultsMap: Map<string, ResultSet[]>;

    beforeEach(() => {
        resultsMap = new Map();
        manager = new ExportManager(resultsMap);
        jest.clearAllMocks();
    });

    describe('hydrateExportData', () => {
        it('should return empty array for invalid metadata', () => {
            const result = manager.hydrateExportData({ sourceUri: 'test', results: [] });
            expect(result).toEqual([]);
        });

        it('should return empty array if source not in results map', () => {
            const metadata: ExcelExportMetadata = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            const result = manager.hydrateExportData(metadata);
            expect(result).toEqual([]);
        });

        it('should hydrate data correctly', () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' }
                ],
                data: [
                    [1, 'Alice'],
                    [2, 'Bob']
                ],
                sql: 'SELECT * FROM users'
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            const metadata: ExcelExportMetadata = {
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0, 1],
                        columnIds: ['0', '1'],
                        name: 'Users',
                        isActive: true
                    }
                ]
            };

            const result = manager.hydrateExportData(metadata);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Users');
            expect(result[0].sql).toBe('SELECT * FROM users');
            expect(result[0].columns).toHaveLength(2);
            expect(result[0].rows).toHaveLength(2);
        });

        it('should filter columns correctly', () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' },
                    { name: 'email', type: 'string' }
                ],
                data: [
                    [1, 'Alice', 'alice@test.com'],
                    [2, 'Bob', 'bob@test.com']
                ]
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            const metadata: ExcelExportMetadata = {
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0', '2'], // Only id and email
                        name: 'Filtered',
                        isActive: true
                    }
                ]
            };

            const result = manager.hydrateExportData(metadata);

            expect(result[0].columns).toHaveLength(2);
            expect(result[0].columns[0].name).toBe('id');
            expect(result[0].columns[1].name).toBe('email');
            expect(result[0].rows[0]).toEqual([1, 'alice@test.com']);
        });

        it('should skip empty result sets (like CREATE TEMP TABLE)', () => {
            const sourceUri = 'file:///test.sql';
            const emptyResultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [],
                sql: 'CREATE TEMP TABLE XYZ AS SELECT * FROM table'
            } as ResultSet;
            const dataResultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }],
                data: [[1, 'Alice']],
                sql: 'SELECT * FROM XYZ'
            } as ResultSet;
            resultsMap.set(sourceUri, [emptyResultSet, dataResultSet]);

            const metadata: ExcelExportMetadata = {
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [],
                        columnIds: ['0'],
                        name: 'Empty',
                        isActive: false
                    },
                    {
                        resultSetIndex: 1,
                        rowIndices: [0],
                        columnIds: ['0', '1'],
                        name: 'Data',
                        isActive: true
                    }
                ]
            };

            const result = manager.hydrateExportData(metadata);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Data');
            expect(result[0].rows).toHaveLength(1);
        });

        it('should ignore stale row indices after partial-result truncation', () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' }
                ],
                data: [
                    [1, 'Alice'],
                    [2, 'Bob']
                ],
                sql: 'SELECT * FROM users'
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            const metadata: ExcelExportMetadata = {
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0, 2, 1],
                        columnIds: ['0', '1'],
                        name: 'Users',
                        isActive: true
                    }
                ]
            };

            const result = manager.hydrateExportData(metadata);

            expect(result).toHaveLength(1);
            expect(result[0].rows).toEqual([
                [1, 'Alice'],
                [2, 'Bob']
            ]);
        });

        it('should keep cancelled partial rows exportable after state-manager truncation', () => {
            const sourceUri = 'file:///cancelled.sql';
            const stateManager = new ResultStateManager();
            stateManager.startExecution(sourceUri);
            stateManager.updateResults(
                [
                    {
                        columns: [
                            { name: 'id', type: 'int' },
                            { name: 'name', type: 'string' }
                        ],
                        data: [
                            [1, 'Alice'],
                            [2, 'Bob'],
                            [3, 'Carol']
                        ],
                        sql: 'SELECT * FROM users'
                    } as ResultSet
                ],
                sourceUri
            );
            stateManager.cancelExecution(sourceUri, [1, 2]);

            const stateBackedManager = new ExportManager(stateManager.resultsMap);
            const result = stateBackedManager.hydrateExportData({
                sourceUri,
                results: [
                    {
                        resultSetIndex: 1,
                        rowIndices: [0, 2, 1],
                        columnIds: ['0', '1'],
                        name: 'Cancelled Users',
                        isActive: true
                    }
                ]
            });

            expect(result).toHaveLength(1);
            expect(result[0].rows).toEqual([
                [1, 'Alice'],
                [2, 'Bob']
            ]);
        });

        it('should hydrate disk-backed SQLite results when host data array is empty', () => {
            try {
                 
                require('node:sqlite');
            } catch {
                return;
            }

            const { SqliteResultStore } = require('../core/resultDataProvider/sqliteResultStore') as typeof import('../core/resultDataProvider/sqliteResultStore');
            const { diskBackedStoreRegistry } = require('../core/resultDataProvider/diskBackedStoreRegistry') as typeof import('../core/resultDataProvider/diskBackedStoreRegistry');

            const store = SqliteResultStore.create(
                [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' },
                ],
                100,
            );
            store.insertRows([
                [1, 'Alice'],
                [2, 'Bob'],
            ]);
            diskBackedStoreRegistry.register(store);

            const sourceUri = 'file:///disk-export.sql';
            resultsMap.set(sourceUri, [
                {
                    columns: [
                        { name: 'id', type: 'int' },
                        { name: 'name', type: 'string' },
                    ],
                    data: [],
                    storageMode: 'sqlite',
                    diskStoreId: store.id,
                    totalRowCount: 2,
                    sql: 'SELECT * FROM users',
                } as ResultSet,
            ]);

            const result = manager.hydrateExportData({
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [],
                        columnIds: ['0', '1'],
                        name: 'Users',
                        isActive: true,
                    },
                ],
            });

            diskBackedStoreRegistry.dispose(store.id);

            expect(result).toHaveLength(1);
            expect(result[0].rows).toEqual([
                [1, 'Alice'],
                [2, 'Bob'],
            ]);
        });

        it('should export disk-backed rows with active diskQuerySpec filters', () => {
            let sqliteAvailable = true;
            try {
                 
                require('node:sqlite');
            } catch {
                sqliteAvailable = false;
            }
            if (!sqliteAvailable) {
                return;
            }

            const { SqliteResultStore } = require('../core/resultDataProvider/sqliteResultStore') as typeof import('../core/resultDataProvider/sqliteResultStore');
            const { diskBackedStoreRegistry } = require('../core/resultDataProvider/diskBackedStoreRegistry') as typeof import('../core/resultDataProvider/diskBackedStoreRegistry');

            const store = SqliteResultStore.create(
                [
                    { name: 'id', type: 'int' },
                    { name: 'name', type: 'string' },
                ],
                100,
            );
            store.insertRows([
                [1, 'Alice'],
                [2, 'Bob'],
                [3, 'Alice'],
            ]);
            diskBackedStoreRegistry.register(store);

            const sourceUri = 'file:///disk-filtered-export.sql';
            resultsMap.set(sourceUri, [
                {
                    columns: [
                        { name: 'id', type: 'int' },
                        { name: 'name', type: 'string' },
                    ],
                    data: [],
                    storageMode: 'sqlite',
                    diskStoreId: store.id,
                    totalRowCount: 3,
                    diskQuerySpec: {
                        columnFilters: [{ columnIndex: 1, values: ['Alice'] }],
                    },
                    sql: 'SELECT * FROM users',
                } as ResultSet,
            ]);

            const result = manager.hydrateExportData({
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [],
                        columnIds: ['0', '1'],
                        name: 'Users',
                        isActive: true,
                    },
                ],
            });

            diskBackedStoreRegistry.dispose(store.id);

            expect(result).toHaveLength(1);
            expect(result[0].rows).toEqual([
                [1, 'Alice'],
                [3, 'Alice'],
            ]);
        });

        it('should preserve requested multi-grid export order with filtered columns and stale row indices', () => {
            const sourceUri = 'file:///multi-grid.sql';
            resultsMap.set(sourceUri, [
                {
                    columns: [
                        { name: 'id', type: 'int' },
                        { name: 'name', type: 'string' },
                        { name: 'region', type: 'string' }
                    ],
                    data: [
                        [1, 'Alice', 'EMEA'],
                        [2, 'Bob', 'APAC']
                    ],
                    sql: 'SELECT * FROM users'
                } as ResultSet,
                {
                    columns: [
                        { name: 'job_id', type: 'int' },
                        { name: 'status', type: 'string' },
                        { name: 'duration_ms', type: 'int' }
                    ],
                    data: [
                        [11, 'queued', 50],
                        [12, 'running', 80],
                        [13, 'done', 120]
                    ],
                    sql: 'SELECT * FROM jobs'
                } as ResultSet,
                {
                    columns: [
                        { name: 'metric', type: 'string' },
                        { name: 'value', type: 'int' }
                    ],
                    data: [
                        ['rows', 2],
                        ['duration', 120]
                    ],
                    sql: 'SELECT * FROM metrics'
                } as ResultSet
            ]);

            const result = manager.hydrateExportData({
                sourceUri,
                results: [
                    {
                        resultSetIndex: 2,
                        rowIndices: [1, 0],
                        columnIds: ['0', '1'],
                        name: 'Metrics',
                        isActive: false
                    },
                    {
                        resultSetIndex: 1,
                        rowIndices: [2, 99, 0],
                        columnIds: ['1'],
                        name: 'Job Statuses',
                        isActive: true
                    },
                    {
                        resultSetIndex: 0,
                        rowIndices: [1],
                        columnIds: ['2', '1'],
                        name: 'User Regions',
                        isActive: false
                    }
                ]
            });

            expect(result).toHaveLength(3);
            expect(result.map(item => item.name)).toEqual(['Metrics', 'Job Statuses', 'User Regions']);
            expect(result[0]).toMatchObject({
                isActive: false,
                rows: [
                    ['duration', 120],
                    ['rows', 2]
                ]
            });
            expect(result[1]).toMatchObject({
                isActive: true,
                columns: [{ name: 'status', type: 'string', scale: undefined }],
                rows: [['done'], ['queued']]
            });
            expect(result[2]).toMatchObject({
                isActive: false,
                columns: [
                    { name: 'region', type: 'string', scale: undefined },
                    { name: 'name', type: 'string', scale: undefined }
                ],
                rows: [['APAC', 'Bob']]
            });
        });
    });

    describe('handleExport', () => {
        it('should show error if result set not found', async () => {
            const mockShowErrorMessage = vscode.window.showErrorMessage as jest.Mock;

            await manager.handleExport({
                format: 'csv',
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            });

            expect(mockShowErrorMessage).toHaveBeenCalledWith('Export failed: Result set not found');
        });

        it('should export to CSV successfully', async () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1], [2]]
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            const mockUri = { fsPath: '/test/export.csv' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.handleExport({
                format: 'csv',
                sourceUri,
                resultSetIndex: 0
            });

            expect(exportResultSetToFile).toHaveBeenCalledWith(
                resultSet,
                '/test/export.csv',
                expect.objectContaining({ format: 'csv' })
            );
        });

        it('should show success message after export', async () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]]
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            const mockUri = { fsPath: '/test/export.json' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);
            const mockShowInfo = vscode.window.showInformationMessage as jest.Mock;

            await manager.handleExport({
                format: 'json',
                sourceUri,
                resultSetIndex: 0
            });

            expect(mockShowInfo).toHaveBeenCalledWith(expect.stringContaining('exported to'));
        });

        it('should handle export cancellation', async () => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]]
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);

            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(undefined); // User cancelled

            await manager.handleExport({
                format: 'csv',
                sourceUri,
                resultSetIndex: 0
            });

            expect(exportResultSetToFile).not.toHaveBeenCalled();
        });
    });

    describe('export methods', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]]
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);
        });

        it('should export CSV with string content', async () => {
            const mockUri = { fsPath: '/test.csv' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportCsv('id\n1\n2');

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(mockUri, Buffer.from('id\n1\n2'));
        });

        it('should export CSV with metadata', async () => {
            const mockUri = { fsPath: '/test.csv' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportCsv({
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            });

            expect(exportResultSetToFile).toHaveBeenCalled();
        });

        it('should export JSON with string content', async () => {
            const mockUri = { fsPath: '/test.json' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportJson('[{"id": 1}]');

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(mockUri, Buffer.from('[{"id": 1}]'));
        });

        it('should export XML with string content', async () => {
            const mockUri = { fsPath: '/test.xml' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportXml('<data></data>');

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
        });

        it('should export SQL with string content', async () => {
            const mockUri = { fsPath: '/test.sql' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportSqlInsert('INSERT INTO test VALUES (1)');

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
        });

        it('should export Markdown with string content', async () => {
            const mockUri = { fsPath: '/test.md' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.exportMarkdown('| id |\n| 1 |');

            expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
        });
    });

    describe('Excel operations', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]],
                sql: 'SELECT 1'
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);
        });

        it('should open in Excel with hydrated data', async () => {
            const metadata: ExcelExportMetadata = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            await manager.openInExcel(metadata);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.exportCurrentResultToXlsbAndOpen',
                expect.any(Array),
                undefined
            );
        });

        it('should copy as Excel to clipboard', async () => {
            const metadata: ExcelExportMetadata = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            await manager.copyAsExcel(metadata);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.copyCurrentResultToXlsbClipboard',
                expect.any(Array),
                undefined
            );
        });

        it('should open in XLSX format', async () => {
            const metadata: ExcelExportMetadata = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            await manager.openInExcelXlsx(metadata);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.exportCurrentResultToXlsxAndOpen',
                expect.any(Array),
                undefined
            );
        });
    });

    describe('initiateExport', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]],
                name: 'Test Result'
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);
        });

        it('should show format picker', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined); // User cancelled format selection

            await manager.initiateExport({
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            });

            expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ id: 'excel' }),
                    expect.objectContaining({ id: 'csv' }),
                    expect.objectContaining({ id: 'json' })
                ]),
                expect.any(Object)
            );
        });

        it('should export to XLSB file when selected', async () => {
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ id: 'excel', label: 'Excel (XLSB)' })
                .mockResolvedValueOnce({ id: 'file', label: 'Save to File' });

            const mockUri = { fsPath: '/test.xlsb' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.initiateExport({
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0,
                rowIndices: [0],
                columnIds: ['0']
            });

            expect(exportStructuredToXlsb).toHaveBeenCalled();
        });

        it('should export to XLSX file when selected', async () => {
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ id: 'xlsx', label: 'Excel (XLSX)' })
                .mockResolvedValueOnce({ id: 'file', label: 'Save to File' });

            const mockUri = { fsPath: '/test.xlsx' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.initiateExport({
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0,
                rowIndices: [0],
                columnIds: ['0']
            });

            expect(exportStructuredToXlsx).toHaveBeenCalled();
        });
    });

    describe('initiateExportWithSelection', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1]],
                name: 'Test Result'
            } as ResultSet;
            resultsMap.set(sourceUri, [resultSet]);
        });

        it('should export directly without quick pick prompts', async () => {
            const mockUri = { fsPath: '/test.csv' };
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(mockUri);

            await manager.initiateExportWithSelection(
                {
                    sourceUri: 'file:///test.sql',
                    resultSetIndex: 0,
                    rowIndices: [0],
                    columnIds: ['0']
                },
                'csv',
                'file'
            );

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });
    });

    describe('exportAllResultSetsToExcel', () => {
        it('should export hydrated multi-result data in order and skip empty sheets', async () => {
            const sourceUri = 'file:///test.sql';
            resultsMap.set(sourceUri, [
                {
                    columns: [{ name: 'id', type: 'int' }],
                    data: [],
                    sql: 'CREATE TEMP TABLE t AS SELECT 1'
                } as ResultSet,
                {
                    columns: [
                        { name: 'id', type: 'int' },
                        { name: 'name', type: 'string' }
                    ],
                    data: [
                        [1, 'Alice'],
                        [2, 'Bob']
                    ],
                    sql: 'SELECT * FROM active_users'
                } as ResultSet,
                {
                    columns: [
                        { name: 'id', type: 'int' },
                        { name: 'status', type: 'string' }
                    ],
                    data: [
                        [10, 'ok'],
                        [20, 'queued']
                    ],
                    sql: 'SELECT * FROM jobs'
                } as ResultSet
            ]);

            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ id: 'xlsx', label: 'Excel (XLSX)' })
                .mockResolvedValueOnce({ id: 'temp', label: 'Copy File to Clipboard (Temp)' });

            await manager.exportAllResultSetsToExcel({
                sourceUri,
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [],
                        columnIds: ['0'],
                        name: 'Empty Sheet',
                        isActive: false
                    },
                    {
                        resultSetIndex: 1,
                        rowIndices: [0, 99, 1],
                        columnIds: ['0', '1'],
                        name: 'Active Users',
                        isActive: true
                    },
                    {
                        resultSetIndex: 2,
                        rowIndices: [1],
                        columnIds: ['1'],
                        name: 'Queued Jobs',
                        isActive: false
                    }
                ]
            });

            expect(exportStructuredToXlsx).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        name: 'Active Users',
                        isActive: true,
                        rows: [
                            [1, 'Alice'],
                            [2, 'Bob']
                        ]
                    }),
                    expect.objectContaining({
                        name: 'Queued Jobs',
                        isActive: false,
                        rows: [['queued']]
                    })
                ],
                expect.stringMatching(/netezza_export_all_.*\.xlsx$/),
                true
            );
        });
    });
});
