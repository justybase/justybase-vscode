jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result?: { columns?: Array<{ name: string }>; data?: unknown[][] }) => {
        if (!result?.columns || !result.data) {
            return [];
        }

        return result.data.map((row) => {
            const mapped: Record<string, unknown> = {};
            result.columns?.forEach((column, index) => {
                mapped[column.name] = row[index];
            });
            return mapped;
        });
    })
}));

import type { ExtensionContext } from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { runQueryRaw } from '../core/queryRunner';
import { duckdbSessionMonitorProvider } from '../../extensions/duckdb/src/duckdbSessionMonitorProvider';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { db2SessionMonitorProvider } from '../../extensions/db2/src/db2SessionMonitorProvider';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { mssqlSessionMonitorProvider } from '../../extensions/mssql/src/mssqlSessionMonitorProvider';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mysqlSessionMonitorProvider } from '../../extensions/mysql/src/mysqlSessionMonitorProvider';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { oracleSessionMonitorProvider } from '../../extensions/oracle/src/oracleSessionMonitorProvider';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';

const mockedRunQueryRaw = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;

function createMockContext(): ExtensionContext {
    return {} as ExtensionContext;
}

function createMockConnectionManager(
    details: Partial<{ database: string; user: string }> = {}
): jest.Mocked<Pick<ConnectionManager, 'getActiveConnectionName' | 'getConnection'>> {
    return {
        getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
        getConnection: jest.fn().mockResolvedValue({
            database: details.database ?? 'analytics',
            user: details.user ?? 'tester'
        })
    } as unknown as jest.Mocked<Pick<ConnectionManager, 'getActiveConnectionName' | 'getConnection'>>;
}

function mockRows(rows: readonly Record<string, unknown>[]): void {
    const columns = rows.length > 0
        ? Object.keys(rows[0]).map((name) => ({ name }))
        : [];
    const data = rows.map((row) => columns.map((column) => row[column.name]));
    mockedRunQueryRaw.mockResolvedValue({
        columns,
        data
    } as never);
}

function lastSql(): string {
    const lastCall = mockedRunQueryRaw.mock.calls[mockedRunQueryRaw.mock.calls.length - 1];
    return String(lastCall?.[1] ?? '');
}

describe('partial dialect session monitor wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('enables supportsSessionMonitor and exposes providers for partial dialects', () => {
        expect(duckdbDialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(duckdbDialect.advancedFeatures?.sessionMonitor).toBe(duckdbSessionMonitorProvider);

        expect(oracleDialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(oracleDialect.advancedFeatures?.sessionMonitor).toBe(oracleSessionMonitorProvider);

        expect(db2Dialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(db2Dialect.advancedFeatures?.sessionMonitor).toBe(db2SessionMonitorProvider);

        expect(mssqlDialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(mssqlDialect.advancedFeatures?.sessionMonitor).toBe(mssqlSessionMonitorProvider);

        expect(mysqlDialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(mysqlDialect.advancedFeatures?.sessionMonitor).toBe(mysqlSessionMonitorProvider);
    });
});

describe('mysqlSessionMonitorProvider', () => {
    const context = createMockContext();
    const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('queries INFORMATION_SCHEMA.PROCESSLIST for sessions with optional database filtering', async () => {
        mockRows([{ ID: 12, PID: 12, USERNAME: 'app', DBNAME: 'sales', STATUS: 'Sending data' }]);

        const sessions = await mysqlSessionMonitorProvider.getSessions(context, connectionManager, 'sales');

        expect(sessions[0]).toMatchObject({ ID: 12, USERNAME: 'app', DBNAME: 'sales' });
        expect(lastSql()).toContain('FROM information_schema.PROCESSLIST');
        expect(lastSql()).toContain("UPPER(COALESCE(DB, DATABASE(), ''))");
    });

    it('normalizes numeric storage fields', async () => {
        mockRows([{ DATABASE: 'sales', SCHEMA: 'sales', ALLOC_MB: '12.5', USED_MB: '11.25', AVG_SKEW: '0', TABLE_COUNT: '4' }]);

        const storage = await mysqlSessionMonitorProvider.getStorage(context, connectionManager);

        expect(storage[0]).toMatchObject({
            ALLOC_MB: 12.5,
            USED_MB: 11.25,
            AVG_SKEW: 0,
            TABLE_COUNT: 4
        });
    });

    it('kills valid sessions with KILL', async () => {
        mockedRunQueryRaw.mockResolvedValue(undefined as never);

        await mysqlSessionMonitorProvider.killSession(context, connectionManager, 42);

        expect(lastSql()).toContain('KILL 42');
    });

    it('rejects invalid session IDs', async () => {
        await expect(mysqlSessionMonitorProvider.killSession(context, connectionManager, 0)).rejects.toThrow(
            'Invalid MySQL session ID: 0'
        );
    });
});

describe('mssqlSessionMonitorProvider', () => {
    const context = createMockContext();
    const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('queries dm_exec_requests for active SQL Server requests', async () => {
        mockRows([{ QS_SESSIONID: 77, QS_SQL: 'SELECT 1', QS_ESTMEM: '256', USERNAME: 'sa' }]);

        const queries = await mssqlSessionMonitorProvider.getQueries(context, connectionManager, 'master');

        expect(queries[0]).toMatchObject({ QS_SESSIONID: 77, USERNAME: 'sa', QS_ESTMEM: '256' });
        expect(lastSql()).toContain('FROM sys.dm_exec_requests r');
        expect(lastSql()).toContain('DB_NAME(r.database_id)');
    });

    it('normalizes SQL Server storage fields', async () => {
        mockRows([{ DATABASE: 'master', SCHEMA: 'dbo', ALLOC_MB: '64', USED_MB: '48.5', AVG_SKEW: '0', TABLE_COUNT: '3' }]);

        const storage = await mssqlSessionMonitorProvider.getStorage(context, connectionManager);

        expect(storage[0]).toMatchObject({
            ALLOC_MB: 64,
            USED_MB: 48.5,
            AVG_SKEW: 0,
            TABLE_COUNT: 3
        });
    });

    it('kills valid SQL Server sessions with KILL', async () => {
        mockedRunQueryRaw.mockResolvedValue(undefined as never);

        await mssqlSessionMonitorProvider.killSession(context, connectionManager, 88);

        expect(lastSql()).toContain('KILL 88;');
    });

    it('rejects invalid session IDs', async () => {
        await expect(mssqlSessionMonitorProvider.killSession(context, connectionManager, -1)).rejects.toThrow(
            'Invalid MS SQL Server session ID: -1'
        );
    });
});

describe('oracleSessionMonitorProvider', () => {
    const context = createMockContext();
    const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('queries V$SESSION and V$SQL for Oracle sessions', async () => {
        mockRows([{ ID: 21, PID: 21, USERNAME: 'HR', DBNAME: 'ORCL', STATUS: 'ACTIVE' }]);

        const sessions = await oracleSessionMonitorProvider.getSessions(context, connectionManager);

        expect(sessions[0]).toMatchObject({ ID: 21, USERNAME: 'HR', DBNAME: 'ORCL' });
        expect(lastSql()).toContain('FROM V$SESSION s');
        expect(lastSql()).toContain('LEFT JOIN V$SQL q');
    });

    it('normalizes Oracle storage fields', async () => {
        mockRows([{ DATABASE: 'ORCL', SCHEMA: 'HR', ALLOC_MB: '8.75', USED_MB: '8.75', AVG_SKEW: '0', TABLE_COUNT: '2' }]);

        const storage = await oracleSessionMonitorProvider.getStorage(context, connectionManager);

        expect(storage[0]).toMatchObject({
            ALLOC_MB: 8.75,
            USED_MB: 8.75,
            AVG_SKEW: 0,
            TABLE_COUNT: 2
        });
    });

    it('builds ALTER SYSTEM KILL SESSION blocks for Oracle session termination', async () => {
        mockedRunQueryRaw.mockResolvedValue(undefined as never);

        await oracleSessionMonitorProvider.killSession(context, connectionManager, 15);

        expect(lastSql()).toContain('ALTER SYSTEM KILL SESSION');
        expect(lastSql()).toContain('v_sid CONSTANT NUMBER := 15');
        expect(lastSql()).toContain('WHERE SID = v_sid');
    });

    it('rejects invalid session IDs', async () => {
        await expect(oracleSessionMonitorProvider.killSession(context, connectionManager, 0)).rejects.toThrow(
            'Invalid Oracle session ID: 0'
        );
    });
});

describe('db2SessionMonitorProvider', () => {
    const context = createMockContext();
    const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('queries MON_GET_CONNECTION for Db2 sessions', async () => {
        mockRows([{ ID: 31, PID: 31, USERNAME: 'DB2INST1', DBNAME: 'SAMPLE', STATUS: 'CONNECTED' }]);

        const sessions = await db2SessionMonitorProvider.getSessions(context, connectionManager, 'SAMPLE');

        expect(sessions[0]).toMatchObject({ ID: 31, USERNAME: 'DB2INST1', DBNAME: 'SAMPLE' });
        expect(lastSql()).toContain('FROM TABLE(MON_GET_CONNECTION(NULL, -2))');
        expect(lastSql()).toContain('CURRENT SERVER');
    });

    it('queries MON_GET_ACTIVITY for Db2 running SQL', async () => {
        mockRows([{ QS_SESSIONID: 31, QS_SQL: 'SELECT * FROM STAFF', USERNAME: 'DB2INST1' }]);

        const queries = await db2SessionMonitorProvider.getQueries(context, connectionManager, 'SAMPLE');

        expect(queries[0]).toMatchObject({ QS_SESSIONID: 31, USERNAME: 'DB2INST1' });
        expect(lastSql()).toContain('FROM TABLE(MON_GET_ACTIVITY(NULL, -2)) AS a');
    });

    it('kills valid Db2 sessions with FORCE APPLICATION', async () => {
        mockedRunQueryRaw.mockResolvedValue(undefined as never);

        await db2SessionMonitorProvider.killSession(context, connectionManager, 512);

        expect(lastSql()).toContain('FORCE APPLICATION (512)');
    });

    it('rejects invalid session IDs', async () => {
        await expect(db2SessionMonitorProvider.killSession(context, connectionManager, -2)).rejects.toThrow(
            'Invalid Db2 session ID: -2'
        );
    });
});

describe('duckdbSessionMonitorProvider', () => {
    const context = createMockContext();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('synthesizes a current embedded DuckDB session from connection details', async () => {
        const connectionManager = createMockConnectionManager({
            database: ':memory:',
            user: 'duck-user'
        }) as unknown as ConnectionManager;

        const sessions = await duckdbSessionMonitorProvider.getSessions(context, connectionManager, 'analytics');

        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            ID: 1,
            USERNAME: 'duck-user',
            DBNAME: 'analytics',
            TYPE: 'duckdb'
        });
        expect(String(sessions[0].CONNTIME)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(mockedRunQueryRaw).not.toHaveBeenCalled();
    });

    it('returns no active query rows for embedded DuckDB monitor snapshots', async () => {
        const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

        await expect(duckdbSessionMonitorProvider.getQueries(context, connectionManager)).resolves.toEqual([]);
    });

    it('normalizes DuckDB storage fields from pragma_database_size()', async () => {
        const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;
        mockRows([{ DATABASE: 'memory', SCHEMA: 'main', ALLOC_MB: '4', USED_MB: '3.5', AVG_SKEW: '0', TABLE_COUNT: '2' }]);

        const storage = await duckdbSessionMonitorProvider.getStorage(context, connectionManager);

        expect(storage[0]).toMatchObject({
            ALLOC_MB: 4,
            USED_MB: 3.5,
            AVG_SKEW: 0,
            TABLE_COUNT: 2
        });
        expect(lastSql()).toContain('FROM pragma_database_size()');
    });

    it('maps DuckDB memory resources into systemUtil rows', async () => {
        const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;
        mockRows([{ TAG: 'BASE_TABLE', MEMORY_USAGE_BYTES: '2048', TEMPORARY_STORAGE_BYTES: '64' }]);

        const resources = await duckdbSessionMonitorProvider.getResources(context, connectionManager);

        expect(resources.gra).toEqual([]);
        expect(resources.sysUtilSummary).toBeNull();
        expect(resources.systemUtil[0]).toMatchObject({
            TAG: 'BASE_TABLE',
            MEMORY_USAGE_BYTES: 2048,
            TEMPORARY_STORAGE_BYTES: 64
        });
        expect(lastSql()).toContain('FROM duckdb_memory()');
    });

    it('reports unsupported session termination explicitly', async () => {
        const connectionManager = createMockConnectionManager() as unknown as ConnectionManager;

        await expect(duckdbSessionMonitorProvider.killSession(context, connectionManager, 1)).rejects.toThrow(
            'DuckDB embedded sessions cannot be terminated from the session monitor.'
        );
    });
});
