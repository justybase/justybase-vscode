import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseMetadataProvider } from '../../contracts/database';
import { db2Harness, mssqlHarness, oracleHarness, postgresqlHarness } from './optionalDialectIntegrationHarness';
import { MysqlConnection } from '../../../extensions/mysql/src/mysqlConnection';
import { mysqlMetadataProvider } from '../../../extensions/mysql/src/mysqlSchemaProvider';
import * as menuSql from '../../commands/schema/menuSql';

interface ProbeCase {
    kind: string;
    config?: DatabaseConnectionConfig;
    create(config: DatabaseConnectionConfig): DatabaseConnection;
    provider: DatabaseMetadataProvider;
    schemaSql: string;
    table: string;
    parent: string;
    setup: string[];
    cleanup: string[];
    admin?: (schema: string, database: string) => string[];
}

/**
 * Live check of the schema-tree table folders (keys, indexes, triggers), FK
 * catalogue queries and the dialect-aware menu SQL generators. Each dialect
 * creates ZZ_CLAUDE_* fixture tables and drops them in finally; dialects
 * without *_LIVE_TEST_* configuration are skipped.
 */
const cases: ProbeCase[] = [
    {
        kind: 'postgresql', config: postgresqlHarness.config, create: c => postgresqlHarness.createConnection(c), provider: postgresqlHarness.metadataProvider,
        schemaSql: 'SELECT current_schema() AS s', table: 'zz_claude_t', parent: 'zz_claude_parent',
        setup: [
            'CREATE TABLE zz_claude_parent (id int primary key)',
            'CREATE TABLE zz_claude_t (id int primary key, code varchar(10) unique, pid int references zz_claude_parent(id), qty int check (qty > 0))',
            'CREATE INDEX zz_claude_idx ON zz_claude_t (qty DESC)',
            'CREATE FUNCTION zz_claude_fn() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
            'CREATE TRIGGER zz_claude_trg BEFORE INSERT OR UPDATE ON zz_claude_t FOR EACH ROW EXECUTE FUNCTION zz_claude_fn()',
        ],
        cleanup: ['DROP TABLE IF EXISTS zz_claude_t2', 'DROP TABLE IF EXISTS zz_claude_t', 'DROP TABLE IF EXISTS zz_claude_parent', 'DROP FUNCTION IF EXISTS zz_claude_fn()'],
        admin: (schema) => {
            const ref = { schema, name: 'zz_claude_t' };
            return [
                menuSql.tableCommentSql('postgresql', ref, "Claude's note"),
                menuSql.columnCommentSql('postgresql', ref, 'qty', 'Quantity'),
                menuSql.grantSql('postgresql', ref, 'TABLE', 'SELECT', 'public'),
                menuSql.dropObjectSql('postgresql', 'INDEX', { schema, name: 'zz_claude_idx' }),
                menuSql.dropObjectSql('postgresql', 'TRIGGER', { schema, name: 'zz_claude_trg' }, { parentTable: menuSql.parentTableFromDescription('ON zz_claude_t (enabled)') }),
                menuSql.dropObjectSql('postgresql', 'FUNCTION', { schema, name: 'zz_claude_fn()' }),
                menuSql.renameTableSql('postgresql', ref, 'zz_claude_t2'),
                menuSql.truncateTableSql('postgresql', { schema, name: 'zz_claude_t2' }),
            ];
        },
    },
    {
        kind: 'oracle', config: oracleHarness.config, create: c => oracleHarness.createConnection(c), provider: oracleHarness.metadataProvider,
        schemaSql: "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL", table: 'ZZ_CLAUDE_T', parent: 'ZZ_CLAUDE_PARENT',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_PARENT (ID NUMBER PRIMARY KEY)',
            'CREATE TABLE ZZ_CLAUDE_T (ID NUMBER PRIMARY KEY, CODE VARCHAR2(10) UNIQUE, PID NUMBER REFERENCES ZZ_CLAUDE_PARENT(ID), QTY NUMBER NOT NULL CHECK (QTY > 0))',
            'CREATE INDEX ZZ_CLAUDE_IDX ON ZZ_CLAUDE_T (QTY DESC)',
            'CREATE TRIGGER ZZ_CLAUDE_TRG BEFORE INSERT ON ZZ_CLAUDE_T FOR EACH ROW BEGIN NULL; END;',
        ],
        cleanup: ['DROP TABLE ZZ_CLAUDE_T2 CASCADE CONSTRAINTS PURGE', 'DROP TABLE ZZ_CLAUDE_T CASCADE CONSTRAINTS PURGE', 'DROP TABLE ZZ_CLAUDE_PARENT CASCADE CONSTRAINTS PURGE'],
        admin: (schema) => {
            const ref = { schema, name: 'ZZ_CLAUDE_T' };
            return [
                menuSql.tableCommentSql('oracle', ref, "Claude's note"),
                menuSql.columnCommentSql('oracle', ref, 'QTY', 'Quantity'),
                menuSql.grantSql('oracle', ref, 'TABLE', 'SELECT', 'PUBLIC'),
                menuSql.dropObjectSql('oracle', 'TRIGGER', { schema, name: 'ZZ_CLAUDE_TRG' }),
                menuSql.dropObjectSql('oracle', 'INDEX', { schema, name: 'ZZ_CLAUDE_IDX' }),
                menuSql.renameTableSql('oracle', ref, 'ZZ_CLAUDE_T2'),
                menuSql.truncateTableSql('oracle', { schema, name: 'ZZ_CLAUDE_T2' }),
            ];
        },
    },
    {
        kind: 'mssql', config: mssqlHarness.config, create: c => mssqlHarness.createConnection(c), provider: mssqlHarness.metadataProvider,
        schemaSql: 'SELECT SCHEMA_NAME() AS S', table: 'ZZ_CLAUDE_T', parent: 'ZZ_CLAUDE_PARENT',
        setup: [
            'CREATE TABLE dbo.ZZ_CLAUDE_PARENT (ID int PRIMARY KEY)',
            'CREATE TABLE dbo.ZZ_CLAUDE_T (ID int CONSTRAINT PK_ZZ_CLAUDE_T PRIMARY KEY, CODE varchar(10) UNIQUE, PID int REFERENCES dbo.ZZ_CLAUDE_PARENT(ID), QTY int CHECK (QTY > 0))',
            'CREATE INDEX ZZ_CLAUDE_IDX ON dbo.ZZ_CLAUDE_T (QTY DESC)',
            'CREATE TRIGGER dbo.ZZ_CLAUDE_TRG ON dbo.ZZ_CLAUDE_T AFTER INSERT, UPDATE AS BEGIN SET NOCOUNT ON; END',
        ],
        cleanup: ['DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_T2', 'DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_T', 'DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_PARENT'],
        admin: (schema, database) => {
            const ref = { database, schema, name: 'ZZ_CLAUDE_T' };
            return [
                menuSql.tableCommentSql('mssql', ref, "Claude's note"),
                menuSql.tableCommentSql('mssql', ref, 'Updated note'),
                menuSql.columnCommentSql('mssql', ref, 'QTY', 'Quantity'),
                menuSql.grantSql('mssql', ref, 'TABLE', 'ALL', 'public'),
                menuSql.changeTableOwnerSql('mssql', ref, 'dbo'),
                menuSql.renameTableSql('mssql', ref, 'ZZ_CLAUDE_T2'),
                menuSql.truncateTableSql('mssql', { database, schema, name: 'ZZ_CLAUDE_T2' }),
            ];
        },
    },
    {
        kind: 'mysql', config: process.env.MYSQL_LIVE_TEST_HOST && ['1', 'true', 'yes'].includes((process.env.RUN_MYSQL_INTEGRATION || '').toLowerCase()) ? {
            host: process.env.MYSQL_LIVE_TEST_HOST, database: process.env.MYSQL_LIVE_TEST_DATABASE!, user: process.env.MYSQL_LIVE_TEST_USER!,
            password: process.env.MYSQL_LIVE_TEST_PASSWORD!, port: Number(process.env.MYSQL_LIVE_TEST_PORT || 3306),
        } as DatabaseConnectionConfig : undefined,
        create: c => new MysqlConnection(c), provider: mysqlMetadataProvider,
        schemaSql: 'SELECT DATABASE() AS s', table: 'zz_claude_t', parent: 'zz_claude_parent',
        setup: [
            'CREATE TABLE zz_claude_parent (id int primary key) ENGINE=InnoDB',
            'CREATE TABLE zz_claude_t (id int primary key, code varchar(10) unique, pid int, qty int, CONSTRAINT zz_claude_fk FOREIGN KEY (pid) REFERENCES zz_claude_parent(id), CONSTRAINT zz_claude_chk CHECK (qty > 0)) ENGINE=InnoDB',
            'CREATE INDEX zz_claude_idx ON zz_claude_t (qty DESC)',
        ],
        cleanup: ['DROP TABLE IF EXISTS zz_claude_t2', 'DROP TABLE IF EXISTS zz_claude_t', 'DROP TABLE IF EXISTS zz_claude_parent'],
        admin: (schema) => {
            const ref = { database: schema, schema, name: 'zz_claude_t' };
            return [
                menuSql.tableCommentSql('mysql', ref, "Claude's C:\\note"),
                menuSql.renameTableSql('mysql', ref, 'zz_claude_t2'),
                menuSql.truncateTableSql('mysql', { database: schema, schema, name: 'zz_claude_t2' }),
            ];
        },
    },
    {
        kind: 'db2', config: db2Harness.config, create: c => db2Harness.createConnection(c), provider: db2Harness.metadataProvider,
        schemaSql: 'SELECT RTRIM(CURRENT SCHEMA) AS S FROM SYSIBM.SYSDUMMY1', table: 'ZZ_CLAUDE_T', parent: 'ZZ_CLAUDE_PARENT',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_PARENT (ID INT NOT NULL PRIMARY KEY)',
            'CREATE TABLE ZZ_CLAUDE_T (ID INT NOT NULL PRIMARY KEY, CODE VARCHAR(10) NOT NULL UNIQUE, PID INT REFERENCES ZZ_CLAUDE_PARENT(ID), QTY INT CHECK (QTY > 0))',
            'CREATE INDEX ZZ_CLAUDE_IDX ON ZZ_CLAUDE_T (QTY DESC)',
            'CREATE TRIGGER ZZ_CLAUDE_TRG NO CASCADE BEFORE INSERT ON ZZ_CLAUDE_T REFERENCING NEW AS N FOR EACH ROW SET N.QTY = N.QTY',
        ],
        cleanup: ['DROP TABLE ZZ_CLAUDE_T2', 'DROP TABLE ZZ_CLAUDE_T', 'DROP TABLE ZZ_CLAUDE_PARENT'],
        admin: (schema, database) => {
            const ref = { database, schema, name: 'ZZ_CLAUDE_T' };
            return [
                menuSql.tableCommentSql('db2', ref, "Claude's note"),
                menuSql.columnCommentSql('db2', ref, 'QTY', 'Quantity'),
                menuSql.grantSql('db2', ref, 'TABLE', 'SELECT', 'PUBLIC'),
                menuSql.dropObjectSql('db2', 'TRIGGER', { database, schema, name: 'ZZ_CLAUDE_TRG' }),
                menuSql.dropObjectSql('db2', 'INDEX', { database, schema, name: 'ZZ_CLAUDE_IDX' }),
                menuSql.renameTableSql('db2', ref, 'ZZ_CLAUDE_T2'),
                menuSql.truncateTableSql('db2', { database, schema, name: 'ZZ_CLAUDE_T2' }),
            ];
        },
    },
];

async function rows(connection: DatabaseConnection, sql: string): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    const out: Record<string, unknown>[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < reader.fieldCount; i++) row[reader.getName(i)] = reader.getValue(i);
            out.push(row);
        }
    } finally {
        await reader.close();
    }
    return out;
}

for (const probe of cases) {
    (probe.config ? it : it.skip)(`${probe.kind}: table folders and menu SQL run against the live catalogue`, async () => {
        const errors: string[] = [];
        const counts: Record<string, number> = {};
        if (!probe.config) return;
        const connection = probe.create(probe.config);
        await connection.connect();
        const exec = async (sql: string) => { await rows(connection, sql); };
        try {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* not there */ } }
            for (const sql of probe.setup) { await exec(sql); }
            const schema = String(Object.values((await rows(connection, probe.schemaSql))[0])[0]).trim();
            for (const detail of ['keys', 'indexes', 'triggers'] as const) {
                const sql = probe.provider.buildTableDetailQuery!(probe.config.database, schema, probe.table, detail)!;
                try {
                    counts[detail] = (await rows(connection, sql)).length;
                } catch (e) { errors.push(`${detail}: ${(e as Error).message}`); }
            }
            const keyRows = await rows(connection, probe.provider.buildTableDetailQuery!(probe.config.database, schema, probe.table, 'keys')!);
            const order = ['FOREIGN KEY', 'CHECK', 'UNIQUE', 'PRIMARY KEY'];
            keyRows.sort((a, b) => order.indexOf(String(a.KIND)) - order.indexOf(String(b.KIND)));
            const fkSql = probe.provider.buildForeignKeyRelationshipsQuery?.(probe.config.database);
            if (fkSql) {
                const fks = (await rows(connection, fkSql)).filter(r => String(r.FROM_TABLE ?? r.from_table).toUpperCase() === probe.table.toUpperCase());
                counts.fk = fks.length;
            }
            const ref = { database: probe.config.database, schema, name: probe.table };
            const dropped = keyRows.map(row => menuSql.dropConstraintSql(probe.kind, ref, String(row.NAME), String(row.KIND)));
            for (const sql of [...dropped, ...(probe.admin?.(schema, probe.config.database) ?? [])]) {
                try { await exec(sql.replace(/;\s*$/, '')); } catch (e) { errors.push(`${sql}: ${(e as Error).message}`); }
            }
        } finally {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* fixture already gone */ } }
            await connection.close();
        }
        expect(errors).toEqual([]);
        // PK, UNIQUE, FK and CHECK; the PK/UNIQUE backing indexes plus the explicit one.
        expect(counts.keys).toBe(4);
        expect(counts.indexes).toBeGreaterThanOrEqual(3);
        expect(counts.fk).toBe(1);
    }, 180000);
}
