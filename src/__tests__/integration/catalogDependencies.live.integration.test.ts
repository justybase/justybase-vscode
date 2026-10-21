import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseMetadataProvider } from '../../contracts/database';
import { db2Harness, mssqlHarness, oracleHarness, postgresqlHarness } from './optionalDialectIntegrationHarness';
import { MysqlConnection } from '../../../extensions/mysql/src/mysqlConnection';
import { mysqlMetadataProvider } from '../../../extensions/mysql/src/mysqlSchemaProvider';
import { buildERDDataFromCatalogRows } from '../../schema/erdProvider';
import { catalogDependencyEdges } from '../../services/analysis/databaseAnalysisService';
import { DependencyIndex } from '../../services/analysis/dependencyIndex';

interface ProbeCase { kind: string; config?: DatabaseConnectionConfig; create(c: DatabaseConnectionConfig): DatabaseConnection; provider: DatabaseMetadataProvider; setup: string[]; cleanup: string[] }
const cases: ProbeCase[] = [
    { kind: 'postgresql', config: postgresqlHarness.config, create: c => postgresqlHarness.createConnection(c), provider: postgresqlHarness.metadataProvider,
      setup: [
        'CREATE SEQUENCE zz_claude_seq', 'CREATE TABLE zz_claude_parent (id int primary key)', 'CREATE TABLE zz_claude_d (id int default nextval(\'zz_claude_seq\') primary key, qty int, note text, pid int references zz_claude_parent(id))',
        'CREATE VIEW zz_claude_v AS SELECT id, qty FROM zz_claude_d', 'CREATE VIEW zz_claude_v2 AS SELECT id FROM zz_claude_v',
        'CREATE FUNCTION zz_claude_tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
        'CREATE TRIGGER zz_claude_trg BEFORE INSERT ON zz_claude_d FOR EACH ROW EXECUTE FUNCTION zz_claude_tf()',
        'CREATE FUNCTION zz_claude_sum() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT sum(qty) FROM zz_claude_d; END',
      ],
      cleanup: ['DROP VIEW IF EXISTS zz_claude_v2', 'DROP VIEW IF EXISTS zz_claude_v', 'DROP FUNCTION IF EXISTS zz_claude_sum()', 'DROP TABLE IF EXISTS zz_claude_d', 'DROP FUNCTION IF EXISTS zz_claude_tf()', 'DROP SEQUENCE IF EXISTS zz_claude_seq', 'DROP TABLE IF EXISTS zz_claude_parent'] },
    { kind: 'oracle', config: oracleHarness.config, create: c => oracleHarness.createConnection(c), provider: oracleHarness.metadataProvider,
      setup: [
        'CREATE SEQUENCE ZZ_CLAUDE_SEQ', 'CREATE TABLE ZZ_CLAUDE_PARENT (ID NUMBER PRIMARY KEY)', 'CREATE TABLE ZZ_CLAUDE_D (ID NUMBER PRIMARY KEY, QTY NUMBER, PID NUMBER REFERENCES ZZ_CLAUDE_PARENT(ID))',
        'CREATE VIEW ZZ_CLAUDE_V AS SELECT ID, QTY FROM ZZ_CLAUDE_D', 'CREATE VIEW ZZ_CLAUDE_V2 AS SELECT ID FROM ZZ_CLAUDE_V',
        'CREATE PROCEDURE ZZ_CLAUDE_P AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ZZ_CLAUDE_D; END;',
        'CREATE TRIGGER ZZ_CLAUDE_TRG BEFORE INSERT ON ZZ_CLAUDE_D FOR EACH ROW BEGIN :NEW.ID := ZZ_CLAUDE_SEQ.NEXTVAL; END;',
      ],
      cleanup: ['DROP VIEW ZZ_CLAUDE_V2', 'DROP VIEW ZZ_CLAUDE_V', 'DROP PROCEDURE ZZ_CLAUDE_P', 'DROP TABLE ZZ_CLAUDE_D PURGE', 'DROP SEQUENCE ZZ_CLAUDE_SEQ', 'DROP TABLE ZZ_CLAUDE_PARENT PURGE'] },
    { kind: 'mssql', config: mssqlHarness.config, create: c => mssqlHarness.createConnection(c), provider: mssqlHarness.metadataProvider,
      setup: [
        'CREATE TABLE dbo.ZZ_CLAUDE_PARENT (ID int PRIMARY KEY)', 'CREATE TABLE dbo.ZZ_CLAUDE_D (ID int PRIMARY KEY, QTY int, PID int REFERENCES dbo.ZZ_CLAUDE_PARENT(ID))',
        'CREATE VIEW dbo.ZZ_CLAUDE_V WITH SCHEMABINDING AS SELECT ID, QTY FROM dbo.ZZ_CLAUDE_D', 'CREATE VIEW dbo.ZZ_CLAUDE_V2 AS SELECT ID FROM dbo.ZZ_CLAUDE_V',
        'CREATE PROCEDURE dbo.ZZ_CLAUDE_P AS SELECT COUNT(*) FROM dbo.ZZ_CLAUDE_D',
        'CREATE TRIGGER dbo.ZZ_CLAUDE_TRG ON dbo.ZZ_CLAUDE_D AFTER INSERT AS BEGIN SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.ZZ_CLAUDE_V; END',
      ],
      cleanup: ['DROP VIEW IF EXISTS dbo.ZZ_CLAUDE_V2', 'DROP PROCEDURE IF EXISTS dbo.ZZ_CLAUDE_P', 'DROP VIEW IF EXISTS dbo.ZZ_CLAUDE_V', 'DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_D', 'DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_PARENT'] },
    { kind: 'db2', config: db2Harness.config, create: c => db2Harness.createConnection(c), provider: db2Harness.metadataProvider,
      setup: [
        'CREATE SEQUENCE ZZ_CLAUDE_SEQ', 'CREATE TABLE ZZ_CLAUDE_PARENT (ID INT NOT NULL PRIMARY KEY)', 'CREATE TABLE ZZ_CLAUDE_D (ID INT NOT NULL PRIMARY KEY, QTY INT, PID INT REFERENCES ZZ_CLAUDE_PARENT(ID))',
        'CREATE VIEW ZZ_CLAUDE_V AS SELECT ID, QTY FROM ZZ_CLAUDE_D', 'CREATE VIEW ZZ_CLAUDE_V2 AS SELECT ID FROM ZZ_CLAUDE_V',
        'CREATE PROCEDURE ZZ_CLAUDE_P (OUT N INT) LANGUAGE SQL BEGIN SELECT COUNT(*) INTO N FROM ZZ_CLAUDE_D; END',
        'CREATE TRIGGER ZZ_CLAUDE_TRG NO CASCADE BEFORE INSERT ON ZZ_CLAUDE_D REFERENCING NEW AS N FOR EACH ROW SET N.ID = NEXT VALUE FOR ZZ_CLAUDE_SEQ',
      ],
      cleanup: ['DROP VIEW ZZ_CLAUDE_V2', 'DROP VIEW ZZ_CLAUDE_V', 'DROP PROCEDURE ZZ_CLAUDE_P', 'DROP TABLE ZZ_CLAUDE_D', 'DROP SEQUENCE ZZ_CLAUDE_SEQ', 'DROP TABLE ZZ_CLAUDE_PARENT'] },
    { kind: 'mysql', config: process.env.MYSQL_LIVE_TEST_HOST && ['1', 'true', 'yes'].includes((process.env.RUN_MYSQL_INTEGRATION || '').toLowerCase()) ? {
        host: process.env.MYSQL_LIVE_TEST_HOST, database: process.env.MYSQL_LIVE_TEST_DATABASE!, user: process.env.MYSQL_LIVE_TEST_USER!,
        password: process.env.MYSQL_LIVE_TEST_PASSWORD!, port: Number(process.env.MYSQL_LIVE_TEST_PORT || 3306) } as DatabaseConnectionConfig : undefined,
      create: c => new MysqlConnection(c), provider: mysqlMetadataProvider,
      setup: ['CREATE TABLE zz_claude_parent (id int primary key) ENGINE=InnoDB', 'CREATE TABLE zz_claude_d (id int primary key, qty int, pid int, CONSTRAINT zz_claude_fk FOREIGN KEY (pid) REFERENCES zz_claude_parent(id)) ENGINE=InnoDB'],
      cleanup: ['DROP TABLE IF EXISTS zz_claude_d', 'DROP TABLE IF EXISTS zz_claude_parent'] },
];
async function rows(c: DatabaseConnection, sql: string) {
    const r = await c.createCommand(sql).executeReader(); const out: Record<string, unknown>[] = [];
    try { while (await r.read()) { const o: Record<string, unknown> = {}; for (let i = 0; i < r.fieldCount; i++) o[r.getName(i)] = r.getValue(i); out.push(o); } } finally { await r.close(); }
    return out;
}
/**
 * Live check of catalog-based ERD and dependency analysis. Each dialect creates
 * ZZ_CLAUDE_* fixtures (table, parent table with FK, views, routine, trigger)
 * and removes them in finally; unconfigured dialects are skipped.
 */
for (const p of cases) {
    (p.config ? it : it.skip)(`${p.kind}: ERD and dependency graph from the live catalogue`, async () => {
        if (!p.config) return;
        const c = p.create(p.config); await c.connect();
        const upper = p.kind === 'oracle' || p.kind === 'db2' || p.kind === 'mssql';
        const name = (value: string) => upper ? value.toUpperCase() : value;
        const setupErrors: string[] = [];
        try {
            for (const s of p.cleanup) { try { await rows(c, s); } catch { /* fixture absent */ } }
            for (const s of p.setup) { try { await rows(c, s); } catch (e) { setupErrors.push(`${s}: ${(e as Error).message}`); } }
            expect(setupErrors).toEqual([]);
            const tableRow = (await rows(c, p.provider.buildObjectTypeQuery(p.config.database, 'TABLE'))).find(r => String(r.OBJNAME) === name('zz_claude_d'))!;
            const schema = String(tableRow.SCHEMA);
            const erd = buildERDDataFromCatalogRows(p.config.database, schema,
                await rows(c, p.provider.buildObjectTypeQuery(p.config.database, 'TABLE')),
                await rows(c, p.provider.buildColumnsWithKeysQuery(p.config.database, { schema, objTypes: ['TABLE'] })),
                await rows(c, p.provider.buildForeignKeyRelationshipsQuery!(p.config.database, { schema })!));
            const edge = erd.relationships.find(r => r.fromTable === `${schema}.${name('zz_claude_d')}`);
            expect(edge).toMatchObject({ toTable: `${schema}.${name('zz_claude_parent')}`, fromColumns: [name('pid')], toColumns: [name('id')] });
            const table = erd.tables.find(t => t.tableName === name('zz_claude_d'))!;
            expect(table.primaryKeyColumns).toEqual([name('id')]);
            expect(table.columns.find(col => col.name === name('pid'))?.isForeignKey).toBe(true);

            const dependencyQuery = p.provider.buildObjectDependenciesQuery?.(p.config.database);
            if (!dependencyQuery) return;
            const { edges, objects } = catalogDependencyEdges(p.config.database, await rows(c, dependencyQuery));
            const index = new DependencyIndex();
            await index.update([], objects, () => false, edges);
            const usedBy = index.getReport({ database: p.config.database, schema, name: name('zz_claude_d'), type: 'TABLE' }, 'incoming', 3);
            const affected = usedBy.affected.map(a => `${a.object.type}:${a.object.name}@${a.depth}`);
            expect(affected).toEqual(expect.arrayContaining([`VIEW:${name('zz_claude_v')}@1`, `VIEW:${name('zz_claude_v2')}@2`]));
            if (p.kind !== 'postgresql') expect(affected).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^PROCEDURE:${name('zz_claude_p')}@1$`))]));
        } finally {
            for (const s of p.cleanup) { try { await rows(c, s); } catch { /* fixture absent */ } }
            await c.close();
        }
    }, 300000);
}
