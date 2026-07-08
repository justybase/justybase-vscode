import * as vscode from 'vscode';
import * as connectionFactory from '../core/connectionFactory';
import type {
    DatabaseDdlProvider,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '../contracts/database';
import type { ConnectionDetails } from '../types';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { duckdbMaintenanceProvider } from '../../extensions/duckdb/src/duckdbMaintenanceProvider';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { mysqlMaintenanceProvider } from '../../extensions/mysql/src/mysqlMaintenanceProvider';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mssqlMaintenanceProvider } from '../../extensions/mssql/src/mssqlMaintenanceProvider';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';
import { oracleMaintenanceProvider } from '../../extensions/oracle/src/oracleMaintenanceProvider';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { db2MaintenanceProvider } from '../../extensions/db2/src/db2MaintenanceProvider';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { postgresqlMaintenanceProvider } from '../../extensions/postgresql/src/postgresqlMaintenanceProvider';

jest.mock('vscode', () => ({
    window: {
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn()
    }
}));

type MockMaintenanceServices = DatabaseMaintenanceServices & {
    executeSql: jest.Mock;
    getConnectionDetails: jest.Mock;
    openSqlDocument: jest.Mock;
    executeWithProgress: jest.Mock;
    executeAndReport: jest.Mock;
};

const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;

const baseConnectionDetails: ConnectionDetails = {
    host: 'localhost',
    database: 'testdb',
    user: 'tester',
    password: 'secret'
};

function createServices(connectionDetails: ConnectionDetails | undefined = baseConnectionDetails): MockMaintenanceServices {
    return {
        context: {} as vscode.ExtensionContext,
        executeSql: jest.fn().mockResolvedValue(undefined),
        getConnectionDetails: jest.fn().mockResolvedValue(connectionDetails),
        openSqlDocument: jest.fn().mockResolvedValue(undefined),
        executeWithProgress: jest.fn(async (_title: string, task: () => Promise<unknown>) => task()),
        executeAndReport: jest.fn().mockResolvedValue(undefined)
    } as unknown as MockMaintenanceServices;
}

function expectExecutedSql(services: MockMaintenanceServices, expectedSql: string | RegExp): void {
    expect(services.executeAndReport).toHaveBeenCalledTimes(1);
    const sql = services.executeAndReport.mock.calls[0]?.[1];
    expect(typeof sql).toBe('string');
    if (typeof expectedSql === 'string') {
        expect(sql).toBe(expectedSql);
    } else {
        expect(sql).toMatch(expectedSql);
    }
}

describe('partial dialect maintenance wiring', () => {
    it('enables supportsTableMaintenance and exposes providers for partial dialects', () => {
        expect(duckdbDialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(duckdbDialect.advancedFeatures?.maintenance).toBe(duckdbMaintenanceProvider);

        expect(mysqlDialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(mysqlDialect.advancedFeatures?.maintenance).toBe(mysqlMaintenanceProvider);

        expect(mssqlDialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(mssqlDialect.advancedFeatures?.maintenance).toBe(mssqlMaintenanceProvider);

        expect(oracleDialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(oracleDialect.advancedFeatures?.maintenance).toBe(oracleMaintenanceProvider);

        expect(db2Dialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(db2Dialect.advancedFeatures?.maintenance).toBe(db2MaintenanceProvider);

        expect(postgresqlDialect.capabilities.supportsTableMaintenance).toBe(true);
        expect(postgresqlDialect.advancedFeatures?.maintenance).toBe(postgresqlMaintenanceProvider);
    });
});

describe('duckdbMaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'duckdb-conn',
        databaseName: ':memory:',
        schemaName: 'analytics',
        tableName: 'sales',
        qualifiedName: 'analytics.sales'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('runs VACUUM for DuckDB tables after confirmation', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, vacuum');

        await duckdbMaintenanceProvider.vacuumTable!(target, services);

        expectExecutedSql(services, 'VACUUM analytics.sales;');
    });

    it('does not analyze DuckDB tables when the prompt is cancelled', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Cancel');

        await duckdbMaintenanceProvider.analyzeTable!(target, services);

        expect(services.executeAndReport).not.toHaveBeenCalled();
    });
});

describe('mysqlMaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'mysql-conn',
        databaseName: 'analytics',
        schemaName: 'analytics',
        tableName: 'sales',
        qualifiedName: 'analytics.sales'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('runs ANALYZE TABLE for MySQL tables', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, analyze');

        await mysqlMaintenanceProvider.analyzeTable!(target, services);

        expectExecutedSql(services, 'ANALYZE TABLE analytics.sales;');
    });

    it('opens generated recreate DDL for MySQL tables', async () => {
        const services = createServices();
        const ddlProvider = {
            generateDDL: jest.fn().mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE analytics.sales (id INT);'
            })
        } as unknown as DatabaseDdlProvider;
        jest.spyOn(connectionFactory, 'getRequiredDatabaseDdlProvider').mockReturnValue(ddlProvider);

        await mysqlMaintenanceProvider.recreateTable!(target, services);

        expect(services.openSqlDocument).toHaveBeenCalledWith('CREATE TABLE analytics.sales (id INT);');
    });

    it('propagates recreate DDL failures for MySQL tables', async () => {
        const services = createServices();
        const ddlProvider = {
            generateDDL: jest.fn().mockResolvedValue({
                success: false,
                error: 'DDL generation failed'
            })
        } as unknown as DatabaseDdlProvider;
        jest.spyOn(connectionFactory, 'getRequiredDatabaseDdlProvider').mockReturnValue(ddlProvider);

        await expect(mysqlMaintenanceProvider.recreateTable!(target, services)).rejects.toThrow('DDL generation failed');
    });
});

describe('mssqlMaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'mssql-conn',
        databaseName: 'warehouse',
        schemaName: 'dbo',
        tableName: 'sales',
        qualifiedName: 'warehouse.dbo.sales'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('runs UPDATE STATISTICS for SQL Server tables', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, update');

        await mssqlMaintenanceProvider.generateStatistics!(target, services);

        expectExecutedSql(services, 'UPDATE STATISTICS [warehouse].[dbo].[sales];');
    });

    it('runs ALTER INDEX ALL ... REBUILD for SQL Server tables', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, rebuild');

        await mssqlMaintenanceProvider.reindexTable!(target, services);

        expectExecutedSql(services, 'ALTER INDEX ALL ON [warehouse].[dbo].[sales] REBUILD;');
    });
});

describe('oracleMaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'oracle-conn',
        databaseName: 'ORCLCDB',
        schemaName: 'ANALYTICS',
        tableName: 'SALES',
        qualifiedName: 'ANALYTICS.SALES'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('runs DBMS_STATS for Oracle statistics generation', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, generate');

        await oracleMaintenanceProvider.generateStatistics!(target, services);

        expectExecutedSql(services, /DBMS_STATS\.GATHER_TABLE_STATS/);
        expect(services.executeAndReport.mock.calls[0]?.[1]).toContain("ownname => 'ANALYTICS'");
        expect(services.executeAndReport.mock.calls[0]?.[1]).toContain("tabname => 'SALES'");
    });

    it('runs ALTER TABLE MOVE for Oracle table compaction', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, move');

        await oracleMaintenanceProvider.vacuumTable!(target, services);

        expectExecutedSql(services, 'ALTER TABLE ANALYTICS.SALES MOVE;');
    });

    it('builds index rebuild blocks for Oracle tables', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, rebuild');

        await oracleMaintenanceProvider.reindexTable!(target, services);

        expectExecutedSql(services, /FROM ALL_INDEXES/);
        expect(services.executeAndReport.mock.calls[0]?.[1]).toContain("TABLE_OWNER = 'ANALYTICS'");
        expect(services.executeAndReport.mock.calls[0]?.[1]).toContain("TABLE_NAME = 'SALES'");
    });
});

describe('db2MaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'db2-conn',
        databaseName: 'SAMPLE',
        schemaName: 'ADMIN',
        tableName: 'SALES',
        qualifiedName: 'ADMIN.SALES'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('runs RUNSTATS through ADMIN_CMD for Db2 tables', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, generate');

        await db2MaintenanceProvider.generateStatistics!(target, services);

        expectExecutedSql(services, "CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ADMIN.SALES ON ALL COLUMNS AND DETAILED INDEXES ALL');");
    });

    it('runs REORG TABLE through ADMIN_CMD for Db2 tables', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, reorganize');

        await db2MaintenanceProvider.vacuumTable!(target, services);

        expectExecutedSql(services, "CALL SYSPROC.ADMIN_CMD('REORG TABLE ADMIN.SALES ALLOW WRITE ACCESS');");
    });

    it('runs REORG INDEXES through ADMIN_CMD for Db2 tables', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, rebuild');

        await db2MaintenanceProvider.reindexTable!(target, services);

        expectExecutedSql(services, "CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE ADMIN.SALES ALLOW WRITE ACCESS');");
    });

    it('fails recreate when connection details are unavailable', async () => {
        const services = createServices();
        services.getConnectionDetails.mockResolvedValue(undefined);

        await expect(db2MaintenanceProvider.recreateTable!(target, services)).rejects.toThrow(
            'Connection details not found for db2-conn.'
        );
    });
});

describe('postgresqlMaintenanceProvider', () => {
    const target: DatabaseMaintenanceTarget = {
        connectionName: 'postgresql-conn',
        databaseName: 'analytics',
        schemaName: 'public',
        tableName: 'orders',
        qualifiedName: 'public.orders'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('creates indexes without schema-qualifying the index name', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, create');

        await postgresqlMaintenanceProvider.createIndex!(
            target,
            {
                columns: ['created_at'],
                indexName: 'orders_created_at_idx'
            },
            services
        );

        expectExecutedSql(
            services,
            'CREATE INDEX orders_created_at_idx ON public.orders (created_at);'
        );
    });

    it('builds REINDEX TABLE options using PostgreSQL option syntax', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, reindex');

        await postgresqlMaintenanceProvider.reindexWithOptions!(
            target,
            {
                concurrently: true,
                verbose: true,
                tablespace: 'fastspace'
            },
            services
        );

        expectExecutedSql(
            services,
            'REINDEX TABLE (CONCURRENTLY, VERBOSE, TABLESPACE fastspace) public.orders;'
        );
    });

    it('builds REINDEX INDEX options using PostgreSQL option syntax', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, reindex');

        await postgresqlMaintenanceProvider.reindexIndex!(
            target,
            'orders_created_at_idx',
            {
                concurrently: true,
                verbose: true,
                tablespace: 'fastspace'
            },
            services,
            'archive'
        );

        expectExecutedSql(
            services,
            'REINDEX INDEX (CONCURRENTLY, VERBOSE, TABLESPACE fastspace) archive.orders_created_at_idx;'
        );
    });

    it('drops partitions using the selected partition schema', async () => {
        const services = createServices();
        showWarningMessage.mockResolvedValue('Yes, drop');

        await postgresqlMaintenanceProvider.dropPartition!(
            target,
            'orders_2024_01',
            services,
            false,
            'archive'
        );

        expectExecutedSql(services, 'DROP TABLE archive.orders_2024_01;');
    });

    it('detaches partitions using the selected partition schema', async () => {
        const services = createServices();
        showInformationMessage.mockResolvedValue('Yes, detach');

        await postgresqlMaintenanceProvider.detachPartition!(
            target,
            'orders_2024_01',
            services,
            true,
            'archive'
        );

        expectExecutedSql(
            services,
            'ALTER TABLE public.orders DETACH PARTITION archive.orders_2024_01 CONCURRENTLY;'
        );
    });
});
