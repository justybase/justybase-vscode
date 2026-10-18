import type { DatabaseCapabilities } from '../contracts/database';
import { netezzaDialect } from '../dialects/netezza';
import { sqliteDialect } from '../dialects/sqlite';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';

jest.mock('vscode', () => ({
    window: {
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn()
    }
}));

type CapabilityExpectation = Partial<DatabaseCapabilities>;

const dialects: Record<string, { capabilities: DatabaseCapabilities }> = {
    netezza: netezzaDialect,
    postgresql: postgresqlDialect,
    db2: db2Dialect,
    oracle: oracleDialect,
    sqlite: sqliteDialect,
    duckdb: duckdbDialect,
    mysql: mysqlDialect,
    mssql: mssqlDialect,
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
        // Previously: reindex = pg, oracle, db2, mssql, sqlite
        expectCapabilities('postgresql', { supportsReindexTable: true });
        expectCapabilities('oracle', { supportsReindexTable: true });
        expectCapabilities('db2', { supportsReindexTable: true });
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
                supportsColumnComments: true,
                supportsGrants: true,
                supportsTableRename: true,
                supportsTableOwnerChange: true,
                supportsPrimaryKeyChanges: true,
                supportsUniqueConstraintChanges: true,
                supportsTruncateTable: true,
            });
        }
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
});
