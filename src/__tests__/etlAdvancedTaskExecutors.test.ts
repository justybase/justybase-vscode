import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exportToCsv } from '../export/csvExporter';
import { exportQueryToXlsb } from '../export/xlsbExporter';
import { ImportResult, importDataToNetezza } from '../import/dataImporter';
import { importDataToPostgreSql } from '../import/postgresqlImporter';
import { ExecutionContext, IExportStrategy, IPythonRunner, IVariableResolver } from '../etl/interfaces';
import { EtlNode, ExportNodeConfig, ImportNodeConfig, PythonNodeConfig } from '../etl/etlTypes';
import { ExportTaskExecutor } from '../etl/tasks/exportTask';
import { ImportTaskExecutor } from '../etl/tasks/importTask';
import { PythonTaskExecutor } from '../etl/tasks/pythonTask';
import { ConnectionDetails } from '../types';

jest.mock('fs', () => {
    const actualFs = jest.requireActual('fs');
    return {
        ...actualFs,
        existsSync: jest.fn(),
        promises: {
            ...actualFs.promises,
            writeFile: jest.fn(),
            unlink: jest.fn()
        }
    };
});

jest.mock('../export/csvExporter', () => ({
    exportToCsv: jest.fn()
}));

jest.mock('../export/xlsbExporter', () => ({
    exportQueryToXlsb: jest.fn()
}));

jest.mock('../import/dataImporter', () => ({
    importDataToNetezza: jest.fn()
}));

jest.mock('../import/postgresqlImporter', () => ({
    importDataToPostgreSql: jest.fn()
}));

const exportToCsvMock = exportToCsv as unknown as jest.Mock;
const exportQueryToXlsbMock = exportQueryToXlsb as unknown as jest.Mock;
const importDataToNetezzaMock = importDataToNetezza as unknown as jest.Mock;
const importDataToPostgreSqlMock = importDataToPostgreSql as unknown as jest.Mock;

const createResolver = (): IVariableResolver => ({
    resolve: (template: string, variables: Record<string, string>) =>
        template.replace(/\$\{([^}]+)\}/g, (_full, key: string) => variables[key] ?? '')
});

const baseConnectionDetails: ConnectionDetails = {
    host: 'localhost',
    port: 5480,
    database: 'TESTDB',
    user: 'admin',
    password: 'secret'
};

const createContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
    extensionContext: {} as vscode.ExtensionContext,
    variables: {},
    nodeOutputs: new Map<string, unknown>(),
    connectionDetails: baseConnectionDetails,
    cancellationToken: undefined,
    onProgress: jest.fn(),
    ...overrides
});

describe('ETL advanced task executors', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (fs.existsSync as unknown as jest.Mock).mockReturnValue(true);
        (fs.promises.writeFile as unknown as jest.Mock).mockResolvedValue(undefined);
        (fs.promises.unlink as unknown as jest.Mock).mockResolvedValue(undefined);
    });

    describe('ExportTaskExecutor', () => {
        const createNode = (config: ExportNodeConfig): EtlNode => ({
            id: 'export-node',
            type: 'export',
            name: 'Export Node',
            position: { x: 0, y: 0 },
            config
        });

        it('returns error when outputPath is missing', async () => {
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'csv',
                outputPath: '',
                query: 'SELECT 1'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Output path');
        });

        it('returns error when query and source node are both missing', async () => {
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'csv',
                outputPath: 'C:\\out.csv'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('No query or source node specified');
        });

        it('returns error for in-memory source output export', async () => {
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'csv',
                outputPath: 'C:\\out.csv',
                sourceNodeId: 'previous-node'
            });
            const context = createContext({
                nodeOutputs: new Map<string, unknown>([
                    ['previous-node', { rows: [[1, 'A']], columns: ['ID', 'NAME'] }]
                ])
            });

            const result = await executor.execute(node, context);

            expect(result.status).toBe('error');
            expect(result.error).toContain('In-memory data export is not yet supported');
        });

        it('exports CSV successfully using default strategy', async () => {
            exportToCsvMock.mockResolvedValue(undefined);
            const resolver = createResolver();
            const executor = new ExportTaskExecutor(resolver);
            const node = createNode({
                type: 'export',
                format: 'csv',
                outputPath: '${output}',
                query: 'SELECT * FROM ${table}'
            });
            const context = createContext({
                variables: { output: 'C:\\exports\\users.csv', table: 'users' }
            });

            const result = await executor.execute(node, context);

            expect(result.status).toBe('success');
            expect(exportToCsvMock).toHaveBeenCalledWith(
                context.connectionDetails,
                'SELECT * FROM users',
                'C:\\exports\\users.csv',
                undefined,
                undefined
            );
            expect(context.onProgress).toHaveBeenCalledWith('Exporting to CSV: C:\\exports\\users.csv');
        });

        it('returns error when CSV strategy throws', async () => {
            exportToCsvMock.mockRejectedValue(new Error('CSV failed'));
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'csv',
                outputPath: 'C:\\out.csv',
                query: 'SELECT 1'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('CSV failed');
        });

        it('exports XLSB successfully and maps rows count', async () => {
            exportQueryToXlsbMock.mockResolvedValue({
                success: true,
                message: 'ok',
                details: {
                    rows_exported: 17,
                    columns: 2,
                    file_size_mb: 0.1,
                    file_path: 'C:\\out.xlsb'
                }
            });
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'xlsb',
                outputPath: 'C:\\out.xlsb',
                query: 'SELECT * FROM users'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('success');
            expect(result.rowsAffected).toBe(17);
            expect(exportQueryToXlsbMock).toHaveBeenCalled();
        });

        it('returns error when XLSB strategy reports failure', async () => {
            exportQueryToXlsbMock.mockResolvedValue({
                success: false,
                message: 'XLSB failed'
            });
            const executor = new ExportTaskExecutor(createResolver());
            const node = createNode({
                type: 'export',
                format: 'xlsb',
                outputPath: 'C:\\out.xlsb',
                query: 'SELECT 1'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toBe('XLSB failed');
        });

        it('allows overriding strategy via registerStrategy', async () => {
            const strategy: IExportStrategy = {
                format: 'csv',
                export: jest.fn().mockResolvedValue({
                    success: true,
                    rowsExported: 9
                })
            };
            const executor = new ExportTaskExecutor(createResolver());
            executor.registerStrategy(strategy);

            const result = await executor.execute(
                createNode({
                    type: 'export',
                    format: 'csv',
                    outputPath: 'C:\\custom.csv',
                    query: 'SELECT * FROM custom_table'
                }),
                createContext()
            );

            expect(strategy.export).toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.rowsAffected).toBe(9);
        });
    });

    describe('ImportTaskExecutor', () => {
        const createNode = (config: ImportNodeConfig): EtlNode => ({
            id: 'import-node',
            type: 'import',
            name: 'Import Node',
            position: { x: 0, y: 0 },
            config
        });

        it('returns error when input path is missing', async () => {
            const executor = new ImportTaskExecutor(createResolver());
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: '',
                targetTable: 'orders'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Input path');
        });

        it('returns error when target table is missing', async () => {
            const executor = new ImportTaskExecutor(createResolver());
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: 'C:\\input.csv',
                targetTable: ''
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Target table');
        });

        it('returns error when source file does not exist', async () => {
            (fs.existsSync as unknown as jest.Mock).mockReturnValue(false);
            const executor = new ImportTaskExecutor(createResolver());
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: 'C:\\missing.csv',
                targetTable: 'orders'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Input file not found');
        });

        it('imports successfully using injected importer', async () => {
            const importer = {
                importData: jest.fn(
                    async (
                        _filePath: string,
                        _targetTable: string,
                        _details: ConnectionDetails,
                        progressCallback?: (message: string, increment?: number) => void
                    ): Promise<ImportResult> => {
                        progressCallback?.('Chunk uploaded', 1);
                        return {
                            success: true,
                            message: 'ok',
                            details: {
                                rowsProcessed: 100,
                                rowsInserted: 95
                            }
                        };
                    }
                )
            };
            const executor = new ImportTaskExecutor(createResolver(), importer);
            const context = createContext({
                variables: {
                    input: 'C:\\data\\orders.csv',
                    schema: 'PUBLIC',
                    table: 'orders'
                }
            });
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: '${input}',
                targetSchema: '${schema}',
                targetTable: '${table}',
                timeout: 30
            });

            const result = await executor.execute(node, context);

            expect(importer.importData).toHaveBeenCalledWith(
                'C:\\data\\orders.csv',
                'orders',
                context.connectionDetails,
                expect.any(Function),
                30
            );
            expect(context.onProgress).toHaveBeenCalledWith('[Import] Chunk uploaded');
            expect(result.status).toBe('success');
            expect(result.rowsAffected).toBe(95);
            expect(result.output).toEqual(
                expect.objectContaining({
                    filePath: 'C:\\data\\orders.csv',
                    targetTable: 'PUBLIC.orders',
                    rowsProcessed: 100,
                    rowsInserted: 95
                })
            );
        });

        it('returns error when importer reports failure', async () => {
            const importer = {
                importData: jest.fn().mockResolvedValue({
                    success: false,
                    message: 'Import failed'
                } as ImportResult)
            };
            const executor = new ImportTaskExecutor(createResolver(), importer);
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: 'C:\\data.csv',
                targetTable: 'orders'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toBe('Import failed');
        });

        it('uses default importer implementation when custom importer is not provided', async () => {
            importDataToNetezzaMock.mockResolvedValue({
                success: true,
                message: 'ok',
                details: { rowsInserted: 10, rowsProcessed: 10 }
            } as ImportResult);
            const executor = new ImportTaskExecutor(createResolver());
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: 'C:\\default.csv',
                targetTable: 'orders'
            });

            const result = await executor.execute(node, createContext());

            expect(importDataToNetezzaMock).toHaveBeenCalledWith(
                'C:\\default.csv',
                'orders',
                baseConnectionDetails,
                expect.any(Function),
                undefined,
                undefined
            );
            expect(result.status).toBe('success');
        });

        it('routes default importer implementation to PostgreSQL when dbType is postgresql', async () => {
            importDataToPostgreSqlMock.mockResolvedValue({
                success: true,
                message: 'ok',
                details: { rowsInserted: 8, rowsProcessed: 8 }
            } as ImportResult);
            const executor = new ImportTaskExecutor(createResolver());
            const node = createNode({
                type: 'import',
                format: 'csv',
                inputPath: 'C:\\postgres.csv',
                targetTable: 'orders'
            });

            const result = await executor.execute(node, createContext({
                connectionDetails: {
                    ...baseConnectionDetails,
                    dbType: 'postgresql'
                }
            }));

            expect(importDataToPostgreSqlMock).toHaveBeenCalledWith(
                'C:\\postgres.csv',
                'orders',
                expect.objectContaining({ dbType: 'postgresql' }),
                expect.any(Function),
                undefined,
                undefined
            );
            expect(importDataToNetezzaMock).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
        });
    });

    describe('PythonTaskExecutor', () => {
        const createNode = (config: PythonNodeConfig): EtlNode => ({
            id: 'python-node',
            type: 'python',
            name: 'Python Node',
            position: { x: 0, y: 0 },
            config
        });

        it('returns error when both script and scriptPath are missing', async () => {
            const runner: IPythonRunner = { run: jest.fn() };
            const finder = { find: jest.fn(() => 'python3') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);
            const node = createNode({
                type: 'python',
                script: ''
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Python script or script path is required');
        });

        it('returns error when scriptPath does not exist', async () => {
            (fs.existsSync as unknown as jest.Mock).mockReturnValue(false);
            const runner: IPythonRunner = { run: jest.fn() };
            const finder = { find: jest.fn(() => 'python3') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);
            const node = createNode({
                type: 'python',
                script: '',
                scriptPath: 'C:\\missing.py'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toContain('Script file not found');
            expect(runner.run).not.toHaveBeenCalled();
        });

        it('executes script path successfully and reports output', async () => {
            const runner: IPythonRunner = {
                run: jest.fn().mockResolvedValue({
                    exitCode: 0,
                    stdout: 'line1\nline2',
                    stderr: 'warning1\nwarning2'
                })
            };
            const finder = { find: jest.fn(() => 'python-default') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);
            const context = createContext({
                variables: { env: 'DEV' }
            });
            const node = createNode({
                type: 'python',
                script: '',
                scriptPath: 'C:\\scripts\\task.py',
                interpreter: 'python311',
                arguments: ['--dry-run'],
                timeout: 15
            });

            const result = await executor.execute(node, context);

            expect(runner.run).toHaveBeenCalledWith(
                'python311',
                ['C:\\scripts\\task.py', '--dry-run'],
                expect.objectContaining({
                    ETL_VAR_ENV: 'DEV'
                }),
                15
            );
            expect(context.onProgress).toHaveBeenCalledWith('Using Python interpreter: python311');
            expect(context.onProgress).toHaveBeenCalledWith('[Python] line1');
            expect(context.onProgress).toHaveBeenCalledWith('[Python ERROR] warning1');
            expect(result.status).toBe('success');
            expect(result.output).toBe('line1\nline2');
        });

        it('returns error result when python runner exits with non-zero code', async () => {
            const runner: IPythonRunner = {
                run: jest.fn().mockResolvedValue({
                    exitCode: 2,
                    stdout: 'partial output',
                    stderr: 'python failed'
                })
            };
            const finder = { find: jest.fn(() => 'python3') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);
            const node = createNode({
                type: 'python',
                script: '',
                scriptPath: 'C:\\scripts\\task.py'
            });

            const result = await executor.execute(node, createContext());

            expect(result.status).toBe('error');
            expect(result.error).toBe('python failed');
            expect(result.output).toBe('partial output');
        });

        it('writes inline script to temp file and cleans it up', async () => {
            const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(123456);
            const runner: IPythonRunner = {
                run: jest.fn().mockResolvedValue({
                    exitCode: 0,
                    stdout: 'done',
                    stderr: ''
                })
            };
            const finder = { find: jest.fn(() => 'python-custom') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);
            const context = createContext({
                variables: { value: '42' }
            });
            const node = createNode({
                type: 'python',
                script: 'print("${value}")'
            });

            const result = await executor.execute(node, context);
            const expectedPath = path.join(os.tmpdir(), 'etl_script_123456.py');

            expect(finder.find).toHaveBeenCalled();
            expect(fs.promises.writeFile).toHaveBeenCalledWith(expectedPath, 'print("42")', 'utf-8');
            expect(runner.run).toHaveBeenCalledWith(
                'python-custom',
                [expectedPath],
                expect.objectContaining({ ETL_VAR_VALUE: '42' }),
                undefined
            );
            expect(fs.promises.unlink).toHaveBeenCalledWith(expectedPath);
            expect(result.status).toBe('success');
            expect(result.output).toBe('done');

            dateNowSpy.mockRestore();
        });

        it('ignores cleanup errors for temp script files', async () => {
            jest.spyOn(Date, 'now').mockReturnValue(98765);
            (fs.promises.unlink as unknown as jest.Mock).mockRejectedValue(new Error('cannot delete'));
            const runner: IPythonRunner = {
                run: jest.fn().mockResolvedValue({
                    exitCode: 0,
                    stdout: 'ok',
                    stderr: ''
                })
            };
            const finder = { find: jest.fn(() => 'python3') };
            const executor = new PythonTaskExecutor(createResolver(), runner, finder);

            const result = await executor.execute(
                createNode({
                    type: 'python',
                    script: 'print("ok")'
                }),
                createContext()
            );

            expect(result.status).toBe('success');
            expect(result.output).toBe('ok');
        });
    });
});
