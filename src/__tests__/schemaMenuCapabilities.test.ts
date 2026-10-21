import type { DatabaseCapabilities, DatabaseMetadataProvider } from '../contracts/database';
import { netezzaDialect } from '../dialects/netezza';
import { sqliteDialect } from '../dialects/sqlite';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { clickhouseDialect } from '../../extensions/clickhouse/src/clickhouseDialect';
import { snowflakeDialect } from '../../extensions/snowflake/src/snowflakeDialect';
import { verticaDialect } from '../../extensions/vertica/src/verticaDialect';
import { accessDialect } from '../../extensions/access/src/accessDialect';
import { fileDialect } from '../../extensions/duckdb/src/fileDialect';

jest.mock('vscode', () => ({
    window: {
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn()
    }
}));

type CapabilityExpectation = Partial<DatabaseCapabilities>;

const dialects: Record<string, { capabilities: DatabaseCapabilities; metadataProvider: DatabaseMetadataProvider }> = {
    netezza: netezzaDialect,
    postgresql: postgresqlDialect,
    db2: db2Dialect,
    oracle: oracleDialect,
    sqlite: sqliteDialect,
    duckdb: duckdbDialect,
    mysql: mysqlDialect,
    mssql: mssqlDialect,
    clickhouse: clickhouseDialect,
    snowflake: snowflakeDialect,
    vertica: verticaDialect,
    access: accessDialect,
    file: fileDialect,
};

function expectCapabilities(kind: string, expected: CapabilityExpectation): void {
    const actual = dialects[kind]?.capabilities;
    expect(actual).toBeDefined();
    for (const [key, value] of Object.entries(expected)) {
        expect(actual[key as keyof DatabaseCapabilities]).toBe(value);
    }
}

describe('schema menu capability matrix', () => {
    it('keeps Netezza-only maintenance on Netezza', () => {
        expectCapabilities('netezza', {
            supportsGroomTable: true,
            supportsTableSkewCheck: true,
            supportsTableStatistics: true,
        });
        for (const kind of ['postgresql', 'db2', 'oracle', 'sqlite', 'duckdb', 'mysql', 'mssql']) {
            expectCapabilities(kind, { supportsGroomTable: false, supportsTableSkewCheck: false });
        }
    });

    it('matches the previous vacuum/analyze/reindex menu visibility', () => {
        // Previously: vacuum = pg, mysql, oracle, db2, sqlite, clickhouse
        expectCapabilities('postgresql', { supportsVacuumTable: true });
        expectCapabilities('mysql', { supportsVacuumTable: true });
        expectCapabilities('oracle', { supportsVacuumTable: true });
        expectCapabilities('db2', { supportsVacuumTable: true });
        expectCapabilities('sqlite', { supportsVacuumTable: true });
        expectCapabilities('netezza', { supportsVacuumTable: false });
        expectCapabilities('duckdb', { supportsVacuumTable: false });
        expectCapabilities('mssql', { supportsVacuumTable: false });
        // Previously: analyze = pg, duckdb, mysql, oracle, sqlite
        expectCapabilities('postgresql', { supportsAnalyzeTable: true });
        expectCapabilities('duckdb', { supportsAnalyzeTable: true });
        expectCapabilities('mysql', { supportsAnalyzeTable: true });
        expectCapabilities('oracle', { supportsAnalyzeTable: true });
        expectCapabilities('sqlite', { supportsAnalyzeTable: true });
        expectCapabilities('netezza', { supportsAnalyzeTable: false });
        expectCapabilities('db2', { supportsAnalyzeTable: false });
        expectCapabilities('mssql', { supportsAnalyzeTable: false });
        // Previously: reindex = pg, oracle, db2, mssql, sqlite. Db2 now offers only its own
        // "Reorganize Indexes" entry (with CLEANUP ONLY), which ran the same REORG INDEXES ALL.
        expectCapabilities('postgresql', { supportsReindexTable: true });
        expectCapabilities('oracle', { supportsReindexTable: true });
        expectCapabilities('db2', { supportsReindexTable: false });
        expectCapabilities('mssql', { supportsReindexTable: true });
        expectCapabilities('sqlite', { supportsReindexTable: true });
        expectCapabilities('netezza', { supportsReindexTable: false });
        expectCapabilities('duckdb', { supportsReindexTable: false });
        expectCapabilities('mysql', { supportsReindexTable: false });
        // Previously: generateStatistics = netezza, oracle, db2, mssql, sqlite
        expectCapabilities('netezza', { supportsTableStatistics: true });
        expectCapabilities('oracle', { supportsTableStatistics: true });
        expectCapabilities('db2', { supportsTableStatistics: true });
        expectCapabilities('mssql', { supportsTableStatistics: true });
        expectCapabilities('sqlite', { supportsTableStatistics: true });
        expectCapabilities('postgresql', { supportsTableStatistics: false });
        expectCapabilities('duckdb', { supportsTableStatistics: false });
        expectCapabilities('mysql', { supportsTableStatistics: false });
    });

    it('enables destructive and structural actions for Db2', () => {
        expectCapabilities('db2', {
            supportsTruncateTable: true,
            supportsTableComments: true,
            supportsColumnComments: true,
            supportsGrants: true,
            supportsTableRename: true,
            supportsPrimaryKeyChanges: true,
            supportsForeignKeyChanges: true,
            supportsUniqueConstraintChanges: true,
        });
        expectCapabilities('db2', { supportsTableOwnerChange: false });
    });

    it('matches the previous comment/grant/rename/owner/constraint visibility', () => {
        for (const kind of ['netezza', 'postgresql', 'oracle', 'mysql', 'mssql']) {
            expectCapabilities(kind, {
                supportsTableComments: true,
                supportsGrants: true,
                supportsTableRename: true,
                supportsPrimaryKeyChanges: true,
                supportsUniqueConstraintChanges: true,
                supportsTruncateTable: true,
            });
        }
        for (const kind of ['netezza', 'postgresql', 'mssql', 'snowflake', 'vertica']) {
            expectCapabilities(kind, { supportsTableOwnerChange: true });
        }
        for (const kind of ['oracle', 'mysql', 'db2', 'access']) {
            expectCapabilities(kind, { supportsTableOwnerChange: false });
        }
        for (const kind of ['netezza', 'postgresql', 'oracle', 'mssql', 'db2', 'snowflake', 'file']) {
            expectCapabilities(kind, { supportsColumnComments: true });
        }
        for (const kind of ['mysql', 'vertica', 'access']) {
            expectCapabilities(kind, { supportsColumnComments: false });
        }
        // The Access staged writer has no RENAME, COMMENT or GRANT statements.
        expectCapabilities('access', {
            supportsTableRename: false,
            supportsTableComments: false,
            supportsGrants: false,
            supportsPrimaryKeyChanges: true,
            supportsForeignKeyChanges: true,
            supportsTruncateTable: true,
        });
        expectCapabilities('netezza', { supportsForeignKeyChanges: false });
        for (const kind of ['postgresql', 'oracle', 'mysql', 'mssql']) {
            expectCapabilities(kind, { supportsForeignKeyChanges: true });
        }
        for (const kind of ['sqlite', 'duckdb']) {
            expectCapabilities(kind, {
                supportsTableComments: false,
                supportsGrants: false,
                supportsPrimaryKeyChanges: false,
            });
        }
        expectCapabilities('sqlite', { supportsTruncateTable: true, supportsTableRename: true });
        expectCapabilities('duckdb', { supportsTruncateTable: true, supportsTableRename: true });
    });

    it('reserves SQLite database maintenance for SQLite', () => {
        expectCapabilities('sqlite', { supportsSqliteDatabaseMaintenance: true });
        for (const kind of ['netezza', 'postgresql', 'db2', 'oracle', 'duckdb', 'mysql', 'mssql']) {
            expectCapabilities(kind, { supportsSqliteDatabaseMaintenance: false });
        }
    });

    it('enables schema value search where the Tauri reference supports it', () => {
        for (const kind of ['netezza', 'postgresql', 'db2', 'sqlite', 'duckdb']) {
            expectCapabilities(kind, { supportsSchemaValueSearch: true });
        }
        for (const kind of ['oracle', 'mysql', 'mssql']) {
            expectCapabilities(kind, { supportsSchemaValueSearch: false });
        }
    });

    it('shows ERD and dependency analysis only where the catalog adapter exists', () => {
        const erd = ['netezza', 'postgresql', 'oracle', 'mssql', 'db2', 'mysql'];
        const dependencies = ['netezza', 'postgresql', 'oracle', 'mssql', 'db2'];
        for (const kind of Object.keys(dialects)) {
            expectCapabilities(kind, { supportsErDiagram: erd.includes(kind), supportsDependencyAnalysis: dependencies.includes(kind) });
        }
    });

    it.each(Object.keys(dialects))('%s: report menu flags match the SQL its metadata provider can build', (kind) => {
        const { capabilities, metadataProvider } = dialects[kind];
        const tableReports = [
            ['supportsTableSizeReport', 'size'],
            ['supportsTablePrivilegesReport', 'privileges'],
            ['supportsTableMaintenanceReport', 'maintenance'],
        ] as const;
        const databaseReports = [
            ['supportsLockReport', 'locks'],
            ['supportsInvalidObjectsReport', 'invalidObjects'],
        ] as const;
        for (const [capability, report] of tableReports) {
            const sql = metadataProvider.buildTableReportQuery?.('DB', 'SCHEMA', 'TABLE', report);
            expect({ capability, offered: Boolean(sql?.trim()) }).toEqual({ capability, offered: capabilities[capability] });
        }
        for (const [capability, report] of databaseReports) {
            const sql = metadataProvider.buildDatabaseReportQuery?.('DB', report);
            expect({ capability, offered: Boolean(sql?.trim()) }).toEqual({ capability, offered: capabilities[capability] });
        }
    });

    it('offers Refresh Materialized View only where the refresh SQL was live-verified', () => {
        const refreshable = ['netezza', 'postgresql', 'oracle', 'db2'];
        for (const kind of Object.keys(dialects)) {
            expectCapabilities(kind, { supportsMaterializedViewRefresh: refreshable.includes(kind) });
        }
    });

    it('names the space-reclaim operation the way each dialect does', () => {
        const styles = Object.fromEntries(Object.entries(dialects)
            .filter(([, dialect]) => dialect.capabilities.supportsVacuumTable)
            .map(([kind, dialect]) => [kind, dialect.capabilities.tableReclaimStyle ?? 'vacuum']));
        expect(styles).toEqual({
            postgresql: 'vacuum',
            sqlite: 'vacuum',
            db2: 'reorg',
            oracle: 'move',
            mysql: 'optimize',
            clickhouse: 'optimize',
        });
    });
});
