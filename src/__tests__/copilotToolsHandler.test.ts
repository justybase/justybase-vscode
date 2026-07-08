import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotToolsHandler } from '../services/copilot/CopilotToolsHandler';
import { CopilotExplainTuningTools } from '../services/copilot/tools/CopilotExplainTuningTools';
import { runQuery, runQueryRaw, runExplainQuery, queryResultToRows } from '../core/queryRunner';
import {
    createConnectedDatabaseConnectionFromDetails as createConnectionFromDetails,
    executeDatabaseQuery as executeQueryHelper
} from '../core/connectionFactory';
import { generateDDL } from '../ddlGenerator';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';
import { importDataToNetezza, NetezzaImporter } from '../import/dataImporter';
import { importDataToPostgreSql } from '../import/postgresqlImporter';
import { exportToCsv } from '../export/csvExporter';
import { exportQueryToXlsb, exportStructuredToXlsb } from '../export/xlsbExporter';
import { exportCsvToXlsx, exportStructuredToXlsx } from '../export/xlsxExporter';
import { NZ_QUERIES } from '../metadata/systemQueries';

jest.mock('../core/queryRunner', () => ({
    runQuery: jest.fn(),
    runQueryRaw: jest.fn(),
    runExplainQuery: jest.fn(),
    queryResultToRows: jest.fn((result: { columns?: Array<{ name: string }>; data?: unknown[][] }) => {
        if (!result.columns || !result.data || result.data.length === 0) {
            return [];
        }
        return result.data.map(row => {
            const mapped: Record<string, unknown> = {};
            result.columns!.forEach((col, index) => {
                mapped[col.name] = row[index];
            });
            return mapped;
        });
    })
}));

jest.mock('../core/connectionFactory', () => {
    const actual = jest.requireActual('../core/connectionFactory');
    return {
        ...actual,
        createConnectedDatabaseConnectionFromDetails: jest.fn(),
        executeDatabaseQuery: jest.fn()
    };
});

jest.mock('../metadata/systemQueries', () => ({
    NZ_OBJECT_TYPES: {
        TABLE: 'TABLE',
        VIEW: 'VIEW',
        EXTERNAL_TABLE: 'EXTERNAL TABLE'
    },
    NZ_QUERIES: {
        getTableStats: jest.fn(() => 'SELECT STATS'),
        findTableSchema: jest.fn(() => 'SELECT SCHEMA'),
        listColumnsWithKeys: jest.fn((database: string, options?: { schema?: string; tableName?: string }) => {
            const schemaFilter = options?.schema ? ` AND UPPER(O.SCHEMA) = UPPER('${options.schema}')` : '';
            const tableFilter = options?.tableName ? ` AND UPPER(O.OBJNAME) = UPPER('${options.tableName}')` : '';
            return `
                SELECT O.DBNAME, O.SCHEMA, O.OBJNAME AS TABLENAME, C.ATTNAME, C.FORMAT_TYPE, C.ATTNUM,
                       COALESCE(C.DESCRIPTION, '') AS DESCRIPTION, 0 AS IS_PK, 0 AS IS_FK
                FROM ${database.toUpperCase()}.._V_RELATION_COLUMN C
                JOIN ${database.toUpperCase()}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID
                WHERE O.DBNAME = '${database.toUpperCase()}'
                    ${schemaFilter}
                    ${tableFilter}
            `.trim();
        })
    }
}));

jest.mock('../utils/sqlUtils', () => ({
    escapeSqlIdentifier: jest.fn((v: string) => `"${v}"`),
    escapeSqlLiteral: jest.fn((v: string) => `'${v.replace(/'/g, "''")}'`)
}));

jest.mock('../ddlGenerator', () => ({
    generateDDL: jest.fn()
}));

jest.mock('../import/dataImporter', () => ({
    importDataToNetezza: jest.fn(),
    NetezzaImporter: jest.fn().mockImplementation(() => ({
        analyzeDataTypes: jest.fn().mockResolvedValue([]),
        applyColumnOptions: jest.fn(),
        getSourceHeaders: jest.fn().mockReturnValue(['ID', 'NAME']),
        getSampleRows: jest.fn().mockResolvedValue([['1', 'A']]),
        getColumnMappings: jest.fn().mockReturnValue([
            { sourceColumn: 'ID', targetColumn: 'ID', dataType: 'BIGINT' }
        ]),
        getCsvDelimiter: jest.fn().mockReturnValue(','),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
        getRowsCount: jest.fn().mockReturnValue(1),
        generateCreateTableSql: jest.fn().mockReturnValue('CREATE TABLE ...')
    }))
}));

jest.mock('../import/postgresqlImporter', () => ({
    importDataToPostgreSql: jest.fn()
}));

jest.mock('../export/csvExporter', () => ({
    exportToCsv: jest.fn()
}));

jest.mock('../export/xlsbExporter', () => ({
    exportQueryToXlsb: jest.fn(),
    exportStructuredToXlsb: jest.fn()
}));

jest.mock('../export/xlsxExporter', () => ({
    exportCsvToXlsx: jest.fn(),
    exportStructuredToXlsx: jest.fn()
}));

describe('services/copilot/CopilotToolsHandler', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let connectionManager: any;
    let handler: CopilotToolsHandler;

    beforeEach(() => {
        jest.resetAllMocks();
        (queryResultToRows as jest.Mock).mockImplementation((result: { columns?: Array<{ name: string }>; data?: unknown[][] }) => {
            if (!result.columns || !result.data || result.data.length === 0) {
                return [];
            }
            return result.data.map(row => {
                const mapped: Record<string, unknown> = {};
                result.columns!.forEach((col, index) => {
                    mapped[col.name] = row[index];
                });
                return mapped;
            });
        });
        (NZ_QUERIES.getTableStats as jest.Mock).mockReturnValue('SELECT STATS');
        (NZ_QUERIES.findTableSchema as jest.Mock).mockReturnValue('SELECT SCHEMA');
        (NZ_QUERIES.listColumnsWithKeys as jest.Mock).mockImplementation(
            (database: string, options?: { schema?: string; tableName?: string }) => {
                const schemaFilter = options?.schema ? ` AND UPPER(O.SCHEMA) = UPPER('${options.schema}')` : '';
                const tableFilter = options?.tableName ? ` AND UPPER(O.OBJNAME) = UPPER('${options.tableName}')` : '';
                return `
                    SELECT O.DBNAME, O.SCHEMA, O.OBJNAME AS TABLENAME, C.ATTNAME, C.FORMAT_TYPE, C.ATTNUM,
                           COALESCE(C.DESCRIPTION, '') AS DESCRIPTION, 0 AS IS_PK, 0 AS IS_FK
                    FROM ${database.toUpperCase()}.._V_RELATION_COLUMN C
                    JOIN ${database.toUpperCase()}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID
                    WHERE O.DBNAME = '${database.toUpperCase()}'
                        ${schemaFilter}
                        ${tableFilter}
                `.trim();
            }
        );
        (escapeSqlIdentifier as jest.Mock).mockImplementation((v: string) => `"${v}"`);
        (escapeSqlLiteral as jest.Mock).mockImplementation((v: string) => `'${v.replace(/'/g, "''")}'`);
        (NetezzaImporter as jest.Mock).mockImplementation(() => ({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getSourceHeaders: jest.fn().mockReturnValue(['ID', 'NAME']),
            getSampleRows: jest.fn().mockResolvedValue([['1', 'A']]),
            getColumnMappings: jest.fn().mockReturnValue([
                { sourceColumn: 'ID', targetColumn: 'ID', dataType: 'BIGINT' }
            ]),
            getCsvDelimiter: jest.fn().mockReturnValue(','),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getRowsCount: jest.fn().mockReturnValue(1),
            generateCreateTableSql: jest.fn().mockReturnValue('CREATE TABLE ...')
        }));
        (importDataToNetezza as jest.Mock).mockResolvedValue({ success: true, message: 'ok', details: {} });
        (exportToCsv as jest.Mock).mockResolvedValue(undefined);
        (exportQueryToXlsb as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });
        (exportStructuredToXlsb as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });
        (exportCsvToXlsx as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });
        (exportStructuredToXlsx as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });
        connectionManager = {
            getActiveConnectionName: jest.fn(() => 'conn1'),
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
            getConnection: jest.fn().mockResolvedValue({
                name: 'conn1',
                host: 'localhost',
                database: 'DB1',
                user: 'user',
                password: 'password'
            }),
            getCurrentDatabase: jest.fn().mockResolvedValue('DB1')
        };
        (generateDDL as jest.Mock).mockResolvedValue({
            success: true,
            ddlCode: 'CREATE TABLE T (ID INT);'
        });
        handler = new CopilotToolsHandler(connectionManager, {} as never);
    });

    it('should query tables, columns and sample data', async () => {
        (runQuery as jest.Mock).mockImplementation(async () => {
            return 'ok';
        });
        expect(await handler.getTablesFromDatabase('DB1', 'admin')).toBe('ok');
        
        (runQueryRaw as jest.Mock).mockResolvedValueOnce({
            columns: [
                { name: 'DBNAME' },
                { name: 'SCHEMA' },
                { name: 'TABLENAME' },
                { name: 'ATTNAME' },
                { name: 'FORMAT_TYPE' },
                { name: 'ATTNUM' },
                { name: 'DESCRIPTION' },
                { name: 'IS_PK' },
                { name: 'IS_FK' }
            ],
            data: [['DB', 'SC', 'TABLE', 'COL1', 'INT', 1, '', 0, 0]]
        });
        expect(await handler.getColumnsForTables(['db.sc.table'])).toContain('TABLE');
        
        (runQuery as jest.Mock).mockResolvedValueOnce('ok');
        expect(await handler.getSampleData('DB1.ADMIN.T', undefined, 10)).toBe('ok');
    });

    it('should query tables with cross-database syntax', async () => {
        (runQuery as jest.Mock).mockResolvedValue('OWNER|TABLENAME|TYPE\nADMIN|MYTABLE|TABLE');

        const result = await handler.getTablesFromDatabase('JUST_DATA_2', 'ADMIN');

        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA_2.._V_TABLE'),
            true,
            'conn1'
        );
        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("DATABASE = 'JUST_DATA_2'"),
            true,
            'conn1'
        );
        expect(result).toContain('MYTABLE');
    });

    it('should return empty columns payload for empty table list', async () => {
        const result = await handler.getColumnsForTables([]);
        expect(result).toBe('[]');
        expect(runQuery).not.toHaveBeenCalled();
    });

    it('should query columns with cross-database syntax for tables with explicit database', async () => {
        (runQueryRaw as jest.Mock).mockResolvedValue({
            columns: [
                { name: 'DBNAME' },
                { name: 'SCHEMA' },
                { name: 'TABLENAME' },
                { name: 'ATTNAME' },
                { name: 'FORMAT_TYPE' },
                { name: 'ATTNUM' },
                { name: 'DESCRIPTION' },
                { name: 'IS_PK' },
                { name: 'IS_FK' }
            ],
            data: [
                ['JUST_DATA_2', 'ADMIN', 'FACT_SALES_2', 'ID', 'INTEGER', 1, '', 0, 0],
                ['JUST_DATA_2', 'ADMIN', 'FACT_SALES_2', 'NAME', 'VARCHAR(100)', 2, '', 0, 0]
            ]
        });

        const result = await handler.getColumnsForTables(['JUST_DATA_2.ADMIN.FACT_SALES_2']);

        expect(runQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA_2.._V_RELATION_COLUMN'),
            true,
            connectionManager,
            'conn1',
            undefined,
            undefined,
            undefined,
            undefined,
            false
        );
        expect(result).toContain('FACT_SALES_2');
    });

    it('should query multiple databases when tables span different databases', async () => {
        (runQueryRaw as jest.Mock).mockImplementation(async (_ctx: unknown, sql: string) => {
            if (sql.includes('JUST_DATA..')) {
                return {
                    columns: [
                        { name: 'DBNAME' },
                        { name: 'SCHEMA' },
                        { name: 'TABLENAME' },
                        { name: 'ATTNAME' },
                        { name: 'FORMAT_TYPE' },
                        { name: 'ATTNUM' },
                        { name: 'DESCRIPTION' },
                        { name: 'IS_PK' },
                        { name: 'IS_FK' }
                    ],
                    data: [['JUST_DATA', 'ADMIN', 'TABLE1', 'ID', 'INT', 1, '', 0, 0]]
                };
            }
            if (sql.includes('JUST_DATA_2..')) {
                return {
                    columns: [
                        { name: 'DBNAME' },
                        { name: 'SCHEMA' },
                        { name: 'TABLENAME' },
                        { name: 'ATTNAME' },
                        { name: 'FORMAT_TYPE' },
                        { name: 'ATTNUM' },
                        { name: 'DESCRIPTION' },
                        { name: 'IS_PK' },
                        { name: 'IS_FK' }
                    ],
                    data: [['JUST_DATA_2', 'ADMIN', 'FACT_SALES_2', 'ID', 'INT', 1, '', 0, 0]]
                };
            }
            return { columns: [], data: [] };
        });

        const result = await handler.getColumnsForTables([
            'JUST_DATA.ADMIN.TABLE1',
            'JUST_DATA_2.ADMIN.FACT_SALES_2'
        ]);

        expect(runQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA.._V_RELATION_COLUMN'),
            true,
            connectionManager,
            'conn1',
            undefined,
            undefined,
            undefined,
            undefined,
            false
        );
        expect(runQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA_2.._V_RELATION_COLUMN'),
            true,
            connectionManager,
            'conn1',
            undefined,
            undefined,
            undefined,
            undefined,
            false
        );
        expect(result).toContain('TABLE1');
        expect(result).toContain('FACT_SALES_2');
    });

    it('should use current database for tables without explicit database', async () => {
        (runQueryRaw as jest.Mock).mockResolvedValue({
            columns: [
                { name: 'DBNAME' },
                { name: 'SCHEMA' },
                { name: 'TABLENAME' },
                { name: 'ATTNAME' },
                { name: 'FORMAT_TYPE' },
                { name: 'ATTNUM' },
                { name: 'DESCRIPTION' },
                { name: 'IS_PK' },
                { name: 'IS_FK' }
            ],
            data: [['DB1', 'ADMIN', 'MYTABLE', 'ID', 'INT', 1, '', 0, 0]]
        });

        const result = await handler.getColumnsForTables(['ADMIN.MYTABLE']);

        expect(runQueryRaw).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('DB1.._V_RELATION_COLUMN'),
            true,
            connectionManager,
            'conn1',
            undefined,
            undefined,
            undefined,
            undefined,
            false
        );
        expect(result).toContain('MYTABLE');
    });

    it('should use cache for columns when available', async () => {
        const mockCache = {
            getColumns: jest.fn().mockReturnValue([
                { ATTNAME: 'CACHED_COL', FORMAT_TYPE: 'VARCHAR', label: 'CACHED_COL', detail: 'VARCHAR', kind: 5 }
            ]),
            getColumnsAnySchema: jest.fn(),
            setColumns: jest.fn()
        };
        const handlerWithCache = new CopilotToolsHandler(connectionManager, {} as never, undefined, mockCache as never);

        const result = await handlerWithCache.getColumnsForTables(['DB1.ADMIN.CACHED_TABLE']);

        expect(mockCache.getColumns).toHaveBeenCalledWith('conn1', 'DB1.ADMIN.CACHED_TABLE');
        expect(result).toContain('CACHED_COL');
        expect(runQuery).not.toHaveBeenCalled();
        expect(runQueryRaw).not.toHaveBeenCalled();
    });

    it('should keep legacy pipe output format for columns response', async () => {
        (runQueryRaw as jest.Mock).mockResolvedValue({
            columns: [
                { name: 'DBNAME' },
                { name: 'SCHEMA' },
                { name: 'TABLENAME' },
                { name: 'ATTNAME' },
                { name: 'FORMAT_TYPE' },
                { name: 'ATTNUM' },
                { name: 'DESCRIPTION' },
                { name: 'IS_PK' },
                { name: 'IS_FK' }
            ],
            data: [
                ['DB1', 'ADMIN', 'MYTABLE', 'ID', 'INT', 1, '', 1, 0],
                ['DB1', 'ADMIN', 'MYTABLE', 'NAME', 'VARCHAR(10)', 2, '', 0, 0]
            ]
        });

        const result = await handler.getColumnsForTables(['DB1.ADMIN.MYTABLE']);

        expect(result.split('\n')[0]).toBe('DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL');
        expect(result).toContain('DB1|ADMIN|MYTABLE|ID|INT|f');
        expect(result).toContain('DB1|ADMIN|MYTABLE|NAME|VARCHAR(10)|f');
    });

    it('should query procedures with cross-database syntax', async () => {
        (runQuery as jest.Mock).mockResolvedValue('PROCEDURE|OWNER|RETURNS\nMY_PROC|ADMIN|INT');

        const result = await handler.getProcedures('JUST_DATA_2', 'ADMIN');

        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA_2.._V_PROCEDURE'),
            true,
            'conn1'
        );
        expect(result).toContain('MY_PROC');
    });

    it('should query views with cross-database syntax', async () => {
        (runQuery as jest.Mock).mockResolvedValue('VIEWNAME|OWNER\nMY_VIEW|ADMIN');

        const result = await handler.getViews('JUST_DATA_2', 'ADMIN');

        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('JUST_DATA_2.._V_VIEW'),
            true,
            'conn1'
        );
        expect(result).toContain('MY_VIEW');
    });

    it('should get view definition with dedicated connection', async () => {
        const mockConn = { close: jest.fn().mockResolvedValue(undefined) };
        (createConnectionFromDetails as jest.Mock).mockResolvedValue(mockConn);
        (executeQueryHelper as jest.Mock).mockResolvedValue([{ DEFINITION: 'SELECT * FROM T' }]);

        const result = await handler.getObjectDefinition('JUST_DATA_2.ADMIN.MY_VIEW', 'view');

        // Should create dedicated connection to JUST_DATA_2
        expect(createConnectionFromDetails).toHaveBeenCalledWith(
            expect.objectContaining({ database: 'JUST_DATA_2' })
        );
        expect(executeQueryHelper).toHaveBeenCalledWith(
            mockConn,
            expect.stringContaining("_V_VIEW WHERE DATABASE = 'JUST_DATA_2'")
        );
        expect(result).toContain('SELECT * FROM T');
        expect(mockConn.close).toHaveBeenCalled();
    });

    it('should validate select execution and explain plan', async () => {
        (runQuery as jest.Mock).mockResolvedValue('rows');
        (runExplainQuery as jest.Mock).mockResolvedValue('plan');
        await expect(handler.executeSelectQuery('DELETE FROM T', 10)).rejects.toThrow('Only SELECT queries are allowed.');
        expect(await handler.executeSelectQuery('SELECT * FROM T', 5)).toBe('rows');
        expect(await handler.getExplainPlan('SELECT * FROM T', true)).toBe('plan');
        expect(runExplainQuery).toHaveBeenCalledWith(expect.anything(), 'EXPLAIN VERBOSE SELECT * FROM T', 'conn1', connectionManager, undefined);
    });

    it('should honor provided database scope for execute, explain and sample data', async () => {
        const mockReader = {
            read: jest.fn().mockResolvedValue(false),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const mockConnection = {
            close: jest.fn().mockResolvedValue(undefined),
            on: jest.fn((_event: string, listener: (message: unknown) => void) => listener({ message: 'plan-db' })),
            removeListener: jest.fn(),
            createCommand: jest.fn().mockReturnValue({
                executeReader: jest.fn().mockResolvedValue(mockReader)
            })
        };

        (createConnectionFromDetails as jest.Mock).mockResolvedValue(mockConnection);
        (executeQueryHelper as jest.Mock).mockResolvedValue([{ ID: 1 }]);

        const queryResult = await handler.executeSelectQuery('SELECT * FROM T', 5, 'DB2');
        const sampleResult = await handler.getSampleData('ADMIN.T', 'DB2', 3);
        const explainResult = await handler.getExplainPlan('SELECT * FROM T', false, 'DB2');

        expect(createConnectionFromDetails).toHaveBeenCalledWith(
            expect.objectContaining({ database: 'DB1' }),
            'DB2'
        );
        expect(runQuery).not.toHaveBeenCalled();
        expect(runExplainQuery).not.toHaveBeenCalled();
        expect(queryResult).toContain('"ID": 1');
        expect(sampleResult).toContain('"ID": 1');
        expect(explainResult).toContain('plan-db');
        expect(mockConnection.close).toHaveBeenCalled();
    });

    it('should pass database scope to validateSqlOnDatabase', async () => {
        const explainSpy = jest.spyOn(handler, 'getExplainPlan').mockResolvedValue('plan');

        const result = await handler.validateSqlOnDatabase('SELECT 1', 'DB_SCOPE');

        expect(explainSpy).toHaveBeenCalledWith('SELECT 1', true, 'DB_SCOPE');
        expect(result).toContain('summary:');
        expect(result).toContain('Database validation succeeded');
        expect(result).toContain('"databaseScope": "DB_SCOPE"');
        explainSpy.mockRestore();
    });

    it('should return structured EXPLAIN semantic analysis payload', async () => {
        const explainSpy = jest.spyOn(CopilotExplainTuningTools.prototype, 'getExplainPlan').mockResolvedValue(
            'Hash Join (cost=100..2000 rows=120000 width=16 conf=0)\n' +
            '   Broadcast Motion (cost=1000..5000 rows=150000 width=32 conf=50)'
        );

        const result = await handler.getExplainPlanAnalysis('SELECT * FROM T', true, 'DB1');

        expect(explainSpy).toHaveBeenCalledWith('SELECT * FROM T', true, 'DB1');
        expect(result).toContain('summary:');
        expect(result).toContain('EXPLAIN semantic analysis completed');
        expect(result).toContain('"overallRisk": "high"');
        expect(result).toContain('"hotspots"');
        expect(result).toContain('"graph"');

        explainSpy.mockRestore();
    });

    it('should handle runQuerySafe failures', async () => {
        (runQuery as jest.Mock).mockRejectedValue(new Error('query failed'));
        await expect(handler.getDatabases()).rejects.toThrow('Failed to fetch databases');
    });

    it('should return deep table stats report with skew analysis', async () => {
        const conn = { close: jest.fn().mockResolvedValue(undefined) };
        (createConnectionFromDetails as jest.Mock).mockResolvedValue(conn);
        (executeQueryHelper as jest.Mock)
            .mockResolvedValueOnce([{ DIST_KEY: 'ID', OWNER: 'ADMIN' }])
            .mockResolvedValueOnce([{ ROW_COUNT: 1000 }])
            .mockResolvedValueOnce([
                { ROW_COUNT: 100 },
                { ROW_COUNT: 120 }
            ]);

        const result = await handler.getTableStats('ADMIN.MYTAB', 'DB1', 'deep');
        expect(result).toContain('Table Statistics');
        expect(result).toContain('**Mode:** deep');
        expect(result).toContain('Row Count');
        expect(result).toContain('Data distribution looks balanced');
        expect(conn.close).toHaveBeenCalled();
    });

    it('should generate structured tuning advice payload', async () => {
        const explainReader = {
            read: jest.fn().mockResolvedValue(false),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const conn = {
            close: jest.fn().mockResolvedValue(undefined),
            on: jest.fn((_event: string, listener: (msg: unknown) => void) =>
                listener({ message: 'Nested Loop (cost=100.00..20000000.00 rows=250000 width=16 conf=0)' })
            ),
            removeListener: jest.fn(),
            createCommand: jest.fn().mockReturnValue({
                executeReader: jest.fn().mockResolvedValue(explainReader)
            })
        };
        (createConnectionFromDetails as jest.Mock).mockResolvedValue(conn);
        (executeQueryHelper as jest.Mock)
            .mockResolvedValueOnce([{ DIST_KEY: 'RANDOM', OWNER: 'ADMIN' }])
            .mockResolvedValueOnce([{ TBL_ROWS: 1000, ALLOCATED_BYTES: 1000000, USED_BYTES: 600000, SKEW: 35 }]);

        const result = await handler.getTuningAdvice('SELECT * FROM ADMIN.MYTAB', 'DB1');

        expect(result).toContain('summary:');
        expect(result).toContain('data:');
        expect(result).toContain('next-actions:');
        expect(result).toContain('"recommendations"');
        expect(createConnectionFromDetails).toHaveBeenCalledWith(
            expect.objectContaining({ database: 'DB1' }),
            'DB1'
        );
        expect(runExplainQuery).not.toHaveBeenCalled();
    });

    it('should limit tuning analysis to first referenced table when analyzeAllTables=false', async () => {
        const explainSpy = jest.spyOn(handler, 'getExplainPlan').mockResolvedValue('Hash Join (cost=10..20 rows=10 width=8 conf=50)');
        const statsSpy = jest.spyOn(handler, 'getTableStats').mockResolvedValue(
            '## Table Statistics: DB1.ADMIN.T1\n**Mode:** quick\n**Distribution Key:** ID\n**Skew Ratio:** 5.0%'
        );

        const result = await handler.getTuningAdvice(
            'SELECT * FROM ADMIN.T1 t1 JOIN ADMIN.T2 t2 ON t1.ID = t2.ID',
            'DB1',
            false,
            5
        );

        expect(statsSpy).toHaveBeenCalledTimes(1);
        expect(result).toContain('"analyzeAllTables": false');
        expect(result).toContain('"tableTargets"');

        explainSpy.mockRestore();
        statsSpy.mockRestore();
    });

    it('should return structured error when tuning sql input is missing', async () => {
        const result = await handler.getTuningAdvice('   ');
        expect(result).toContain('summary:');
        expect(result).toContain('SQL input is required for tuning analysis');
    });

    it('should return graceful errors for missing connection/table stats context', async () => {
        connectionManager.getActiveConnectionName.mockReturnValue(undefined);
        expect(await handler.getTableStats('TAB')).toContain('No active database connection');
        connectionManager.getActiveConnectionName.mockReturnValue('conn1');
        connectionManager.getConnection.mockResolvedValue(undefined);
        expect(await handler.getTableStats('TAB')).toContain('not found');
    });

    it('should search schemas and table locations', async () => {
        (runQuery as jest.Mock).mockImplementation(
            async (_ctx: unknown, sql: string) => {
                if (sql.includes('SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE')) return 'DATABASE\nDB1\nDB2';
                // findTableLocations uses _V_OBJECT_DATA with DB prefix - return data that includes TBL
                if (sql.includes('_V_OBJECT_DATA') && sql.includes('TBL')) return 'DATABASE|SCHEMA|TABLE_NAME\nDB1|ADMIN|TBL';
                // searchSchema now uses cross-database syntax too
                if (sql.includes('_V_RELATION_COLUMN')) return 'TABLE_NAME|COLUMN_NAME\nTBL|ID';
                if (sql.includes('_V_TABLE') && sql.includes('ORDERS')) return 'TABLENAME|OWNER\nORDERS|ADMIN';
                if (sql.includes('_V_TABLE')) return 'TABLENAME|OWNER\nTBL|ADMIN';
                if (sql.includes('_V_VIEW')) return 'VIEWNAME|OWNER\nXVIEW|ADMIN';
                if (sql.includes('_V_PROCEDURE')) return 'PROCEDURE|OWNER\nXPROC|ADMIN';
                return 'RESULTS';
            }
        );

        const locations = await handler.findTableLocations('ADMIN.TBL');
        expect(locations).toContain('Found');

        const columns = await handler.searchSchema('id', 'columns');
        const tables = await handler.searchSchema('ord', 'tables');
        const all = await handler.searchSchema('x', 'all');
        expect(columns).toContain('TABLE_NAME');
        expect(tables).toContain('TABLENAME');
        // 'all' uses UNION which returns combined results
        expect(all).toBeDefined();
    });

    it('should get comments with and without column comments', async () => {
        (runQuery as jest.Mock)
            .mockResolvedValueOnce('DESCRIPTION\nMain table comment')
            .mockResolvedValueOnce('COLUMN_NAME|COMMENT\nID|identifier');

        const withColumns = await handler.getComments('ADMIN.MYTABLE', 'DB1', 'ADMIN', true);
        expect(withColumns).toContain('Main table comment');
        expect(withColumns).toContain('| ID | identifier |');

        (runQuery as jest.Mock)
            .mockResolvedValueOnce('DESCRIPTION\n')
            .mockResolvedValueOnce('');
        const withoutColumns = await handler.getComments('MYTABLE', 'DB1', undefined, false);
        expect(withoutColumns).toContain('No comment set');
    });

    it('should validate sql on database and return invalid message when explain fails', async () => {
        (runExplainQuery as jest.Mock).mockRejectedValue(new Error('syntax error'));
        const result = await handler.validateSqlOnDatabase('SELECT * FROM');
        expect(result).toContain('summary:');
        expect(result).toContain('Database validation failed');
        expect(result).toContain('syntax error');
    });

    it('should validate sql with parser', async () => {
        const result = await handler.validateSql('SELECT 1');
        expect(result).toContain('SQL parser validation passed');
    });

    it('should include unified NZ diagnostics in parser validation output', async () => {
        const result = await handler.validateSqlParser('SELECT * FROM T1 CROSS JOIN T2;');
        expect(result).toContain('NZ001');
        expect(result).toContain('NZ004');
        expect(result).toContain('Netezza anti-pattern explainer (ranked fix candidates):');
        expect(result).toContain('confidence=');
        expect(result).toContain('Why it matters in Netezza');
        expect(result).toContain('Rewrite options:');
        expect(result).toContain('Trade-offs:');
    });

    it('should include NZP003-specific anti-pattern guidance when RETURNS is missing', async () => {
        const sql = `
CREATE OR REPLACE PROCEDURE ADMIN.P_TEST()
LANGUAGE NZPLSQL
BEGIN_PROC
    SELECT 1;
END_PROC;
`;

        const result = await handler.validateSqlParser(sql);
        expect(result).toContain('NZP003');
        expect(result).toContain('output contracts ambiguous');
    });

    it('should handle utilities and object metadata methods', async () => {
        (runQuery as jest.Mock).mockResolvedValue('ok');
        expect(await handler.getSchemas()).toBe('ok');
        expect(await handler.getProcedures(undefined, 'admin')).toBe('ok');
        expect(await handler.getViews(undefined, 'admin')).toBe('ok');
        expect(await handler.getExternalTables(undefined, 'admin', 'X%')).toBe('ok');
        // getObjectDefinition for views requires dedicated connection
        const mockConn = { close: jest.fn().mockResolvedValue(undefined) };
        (createConnectionFromDetails as jest.Mock).mockResolvedValue(mockConn);
        (executeQueryHelper as jest.Mock).mockResolvedValue([{ DEFINITION: 'SELECT 1' }]);
        expect(await handler.getObjectDefinition('v1', 'view')).toContain('SELECT 1');
        expect(await handler.getObjectDefinition('p1', 'procedure')).toBe('ok');
        expect(await handler.getObjectDependencies('obj')).toContain('summary:');
    });

    it('should return structured dependency graph from metadata and source scans', async () => {
        (runQuery as jest.Mock).mockImplementation(async (_ctx: unknown, sql: string) => {
            if (sql.includes('_V_OBJECT_DATA')) {
                return JSON.stringify([
                    { DBNAME: 'DB1', SCHEMA: 'ADMIN', OBJNAME: 'ORDERS', OBJTYPE: 'TABLE' }
                ]);
            }
            if (sql.includes('_V_RELATION_KEYDATA')) {
                return JSON.stringify([
                    { DATABASE: 'DB1', SCHEMA: 'ADMIN', DEPENDENT_OBJECT: 'ORDER_ITEMS', CONSTRAINTNAME: 'FK_ORDER_ITEMS_ORDERS' }
                ]);
            }
            if (sql.includes('_V_VIEW')) {
                return JSON.stringify([
                    {
                        DATABASE: 'DB1',
                        SCHEMA: 'REPORTING',
                        DEPENDENT_OBJECT: 'V_ORDERS',
                        DEFINITION: 'SELECT * FROM DB1.ADMIN.ORDERS'
                    }
                ]);
            }
            if (sql.includes('_V_PROCEDURE')) {
                return JSON.stringify([
                    {
                        DATABASE: 'DB1',
                        SCHEMA: 'ETL',
                        DEPENDENT_OBJECT: 'P_LOAD_ORDERS',
                        PROCEDURESOURCE: 'BEGIN_PROC INSERT INTO DB1.ADMIN.ORDER_AUDIT SELECT * FROM DB1.ADMIN.ORDERS; END_PROC;'
                    }
                ]);
            }
            return '[]';
        });

        const result = await handler.getObjectDependencies('ORDERS', undefined, 'TABLE');

        expect(result).toContain('Dependency analysis completed');
        expect(result).toContain('"relationship": "FOREIGN_KEY"');
        expect(result).toContain('"relationship": "VIEW_SQL_REFERENCE"');
        expect(result).toContain('"relationship": "PROCEDURE_SQL_REFERENCE"');
        expect(result).toContain('"objectName": "ORDER_ITEMS"');
        expect(result).toContain('"objectName": "V_ORDERS"');
        expect(result).toContain('"objectName": "P_LOAD_ORDERS"');
        expect(result).toContain('"source": "foreign_key_metadata"');
        expect(result).toContain('"source": "view_definition_sql_parse"');
        expect(result).toContain('"source": "procedure_source_sql_parse"');
        expect(result).toContain('"evidenceSource": "view_definition_sql_parse"');
        expect(result).toContain('"bySource"');
    });

    it('should fall back to text-based dependency evidence when source body is unavailable', async () => {
        (runQuery as jest.Mock).mockImplementation(async (_ctx: unknown, sql: string) => {
            if (sql.includes('_V_OBJECT_DATA')) {
                return JSON.stringify([
                    { DBNAME: 'DB1', SCHEMA: 'ADMIN', OBJNAME: 'ORDERS', OBJTYPE: 'TABLE' }
                ]);
            }
            if (sql.includes('_V_VIEW')) {
                return JSON.stringify([
                    { DATABASE: 'DB1', SCHEMA: 'REPORTING', DEPENDENT_OBJECT: 'V_ORDERS' }
                ]);
            }
            if (sql.includes('_V_PROCEDURE')) {
                return JSON.stringify([
                    { DATABASE: 'DB1', SCHEMA: 'ETL', DEPENDENT_OBJECT: 'P_LOAD_ORDERS' }
                ]);
            }
            return '[]';
        });

        const result = await handler.getObjectDependencies('ORDERS', undefined, 'TABLE');

        expect(result).toContain('"source": "view_definition_text"');
        expect(result).toContain('"source": "procedure_source_text"');
    });

    it('should return partial structured response when target object cannot be resolved', async () => {
        (runQuery as jest.Mock).mockResolvedValue('No resolve dependency target found');

        const result = await handler.getObjectDependencies('MISSING_OBJECT', undefined, 'TABLE');

        expect(result).toContain('summary:');
        expect(result).toContain('no resolved target');
        expect(result).toContain('"partial": true');
        expect(result).toContain('No TABLE object found');
    });

    it('should escape object name and scope metadata lookup to selected database for DATABASE..OBJECT', async () => {
        (runQuery as jest.Mock).mockImplementation(async (_ctx: unknown, sql: string) => {
            if (sql.includes('_V_TABLE')) {
                return 'OWNER\nADMIN';
            }
            return '';
        });

        await handler.getDDL({
            objectName: `DB1..ORD'ERS`,
            objectType: 'table'
        });

        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            `SELECT OWNER FROM "DB1".._V_TABLE WHERE TABLENAME = 'ORD''ERS' LIMIT 1`,
            true,
            'conn1'
        );
    });

    it('should use procedure-specific schema lookup for DATABASE..OBJECT procedures', async () => {
        (runQuery as jest.Mock).mockImplementation(async (_ctx: unknown, sql: string) => {
            if (sql.includes('_V_PROCEDURE')) {
                return 'SCHEMA\nPROC_SCHEMA';
            }
            return '';
        });

        await handler.getDDL({
            objectName: 'DBP..MY_PROC',
            objectType: 'procedure'
        });

        expect(runQuery).toHaveBeenCalledWith(
            expect.anything(),
            `SELECT SCHEMA FROM "DBP".._V_PROCEDURE WHERE PROCEDURE = 'MY_PROC' LIMIT 1`,
            true,
            'conn1'
        );
        expect((runQuery as jest.Mock).mock.calls.some(call => (call[1] as string).includes('_V_TABLE'))).toBe(false);
    });

    it('should default missing object type to table when calling DDL generator', async () => {
        await handler.getDDL({
            objectName: 'MY_TABLE',
            objectType: ''
        });

        expect(generateDDL).toHaveBeenCalledWith(
            expect.anything(),
            'DB1',
            'ADMIN',
            'MY_TABLE',
            'table'
        );
    });

    it('should inspect/propose import and execute dry-run import', async () => {
        const sourceFilePath = path.join(os.tmpdir(), `copilot-tools-handler-${Date.now()}.csv`);
        fs.writeFileSync(sourceFilePath, 'ID,NAME\n1,A');

        const inspectResult = await handler.inspectImportFile(sourceFilePath, 3);
        expect(inspectResult).toContain('summary:');
        expect(NetezzaImporter).toHaveBeenCalledWith(sourceFilePath, 'COPILOT_IMPORT_PREVIEW', undefined);

        const mappingResult = await handler.proposeImportMapping(sourceFilePath, 'DB1.ADMIN.T_IMPORT');
        expect(mappingResult).toContain('proposedCreateTableSql');

        const dryRunResult = await handler.executeImport(sourceFilePath, 'DB1.ADMIN.T_IMPORT', true, 120);
        expect(dryRunResult).toContain('Dry-run completed');

        fs.unlinkSync(sourceFilePath);
    });

    it('should execute import and export query results in csv format', async () => {
        const sourceFilePath = path.join(os.tmpdir(), `copilot-tools-handler-exec-${Date.now()}.csv`);
        fs.writeFileSync(sourceFilePath, 'ID,NAME\n1,A');
        (importDataToNetezza as jest.Mock).mockResolvedValue({
            success: true,
            message: 'ok',
            details: { rowsInserted: 1 }
        });
        (exportToCsv as jest.Mock).mockImplementation(
            async (_conn: unknown, _sql: string, filePath: string) => {
                fs.writeFileSync(filePath, 'ID,NAME\n1,A\n');
            }
        );
        (exportQueryToXlsb as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });
        (exportCsvToXlsx as jest.Mock).mockResolvedValue({ success: true, message: 'ok' });

        const importResult = await handler.executeImport(sourceFilePath, 'DB1.ADMIN.T_IMPORT', false, 120);
        expect(importResult).toContain('Import completed');
        expect(importDataToNetezza).toHaveBeenCalled();

        const exportPath = path.join(os.tmpdir(), `copilot-tools-handler-export-${Date.now()}.csv`);
        const exportResult = await handler.exportQueryResults('SELECT 1', 'csv', exportPath, 30);
        expect(exportResult).toContain('Export completed');
        expect(exportToCsv).toHaveBeenCalled();

        fs.unlinkSync(sourceFilePath);
        if (fs.existsSync(exportPath)) {
            fs.unlinkSync(exportPath);
        }
    });

    it('should route executeImport to PostgreSQL importer for postgresql connections', async () => {
        const sourceFilePath = path.join(os.tmpdir(), `copilot-tools-handler-pg-${Date.now()}.csv`);
        fs.writeFileSync(sourceFilePath, 'ID,NAME\n1,A');
        connectionManager.getConnectionDatabaseKind = jest.fn(() => 'postgresql');
        connectionManager.getConnection = jest.fn().mockResolvedValue({
            name: 'pg-conn',
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            password: 'password',
            dbType: 'postgresql'
        });
        (importDataToPostgreSql as jest.Mock).mockResolvedValue({
            success: true,
            message: 'ok',
            details: { rowsInserted: 1 }
        });

        const importResult = await handler.executeImport(sourceFilePath, 'warehouse.public.t_import', false, 120);

        expect(importResult).toContain('Import completed');
        expect(importDataToPostgreSql).toHaveBeenCalledWith(
            sourceFilePath,
            'warehouse.public.t_import',
            expect.objectContaining({ dbType: 'postgresql' }),
            undefined,
            120,
            undefined
        );
        expect(importDataToNetezza).not.toHaveBeenCalled();

        fs.unlinkSync(sourceFilePath);
    });

    it('should export active results grid when source is activeResults', async () => {
        const exportPath = path.join(os.tmpdir(), `copilot-tools-handler-active-results-${Date.now()}.csv`);
        const resultPanelProvider = {
            getActiveSource: jest.fn().mockReturnValue('file:///test.sql'),
            getResultsForSource: jest.fn().mockReturnValue([
                {
                    columns: [{ name: 'ID', type: 'INT4' }],
                    data: [[1], [2]],
                    isLog: false,
                    sql: 'SELECT ID FROM T'
                }
            ])
        };
        const handlerWithResults = new CopilotToolsHandler(connectionManager, {} as never, resultPanelProvider as never);

        const exportResult = await handlerWithResults.exportQueryResults(undefined, 'csv', exportPath, undefined, 'activeResults');
        expect(exportResult).toContain('Exported active Netezza Results set');
        expect(fs.existsSync(exportPath)).toBe(true);

        fs.unlinkSync(exportPath);
    });
});
