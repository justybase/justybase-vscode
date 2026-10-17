import { describe, expect, it, jest } from '@jest/globals';

jest.unmock('chevrotain');
import type { DatabaseConnection, DatabaseConnectionConfig } from '../../contracts/database';
import { MysqlConnection } from '../../../extensions/mysql/src/mysqlConnection';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import {
  db2Harness,
  mssqlHarness,
  oracleHarness,
  postgresqlHarness,
} from './optionalDialectIntegrationHarness';

interface DdlSmokeCase {
  name: string;
  databaseKind: string;
  config?: DatabaseConnectionConfig;
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection;
  tableName(): string;
  createSql(tableName: string): string;
  alterSql?(tableName: string): string;
  dropSql(tableName: string): string;
}

function mysqlConfig(): DatabaseConnectionConfig | undefined {
  const explicitlyEnabled = ['1', 'true', 'yes'].includes(
    (process.env.RUN_MYSQL_INTEGRATION || process.env.MYSQL_LIVE_TEST_ENABLED || '').trim().toLowerCase(),
  );
  if (!explicitlyEnabled) return undefined;

  const host = process.env.MYSQL_LIVE_TEST_HOST?.trim();
  const database = process.env.MYSQL_LIVE_TEST_DATABASE?.trim();
  const user = process.env.MYSQL_LIVE_TEST_USER?.trim();
  const password = process.env.MYSQL_LIVE_TEST_PASSWORD;
  if (!host || !database || !user || password === undefined) return undefined;

  return {
    host,
    database,
    user,
    password,
    port: Number(process.env.MYSQL_LIVE_TEST_PORT || 3306),
  };
}

function uniqueName(): string {
  return `JBL_DDL_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

const cases: DdlSmokeCase[] = [
  {
    name: 'Db2',
    databaseKind: 'db2',
    config: db2Harness.config,
    createConnection: config => db2Harness.createConnection(config),
    tableName: uniqueName,
    createSql: name => `CREATE TABLE ${name} (ID INTEGER NOT NULL, LABEL VARCHAR(40) NOT NULL) ORGANIZE BY ROW IN USERSPACE1 COMPRESS NO`,
    alterSql: name => `ALTER TABLE ${name} ADD CONSTRAINT PK_${name} PRIMARY KEY (ID) ENFORCED`,
    dropSql: name => `DROP TABLE ${name}`,
  },
  {
    name: 'PostgreSQL',
    databaseKind: 'postgresql',
    config: postgresqlHarness.config,
    createConnection: config => postgresqlHarness.createConnection(config),
    tableName: uniqueName,
    createSql: name => `CREATE TABLE ${name} (id integer, region text) PARTITION BY LIST (region)`,
    dropSql: name => `DROP TABLE IF EXISTS ${name}`,
  },
  {
    name: 'MySQL',
    databaseKind: 'mysql',
    config: mysqlConfig(),
    createConnection: config => new MysqlConnection(config),
    tableName: uniqueName,
    createSql: name => `CREATE TABLE \`${name}\` (id INT NOT NULL, label VARCHAR(40) DEFAULT 'label') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    dropSql: name => `DROP TABLE IF EXISTS \`${name}\``,
  },
  {
    name: 'Microsoft SQL Server',
    databaseKind: 'mssql',
    config: mssqlHarness.config,
    createConnection: config => mssqlHarness.createConnection(config),
    tableName: uniqueName,
    createSql: name => `CREATE TABLE [${name}] ([id] INT NOT NULL, [label] NVARCHAR(40) NULL CONSTRAINT [DF_${name}_LABEL] DEFAULT (N'label'))`,
    alterSql: name => `ALTER TABLE [${name}] ALTER COLUMN [label] NVARCHAR(80) NOT NULL`,
    dropSql: name => `DROP TABLE [${name}]`,
  },
  {
    name: 'Oracle',
    databaseKind: 'oracle',
    config: oracleHarness.config,
    createConnection: config => oracleHarness.createConnection(config),
    tableName: uniqueName,
    createSql: name => `CREATE TABLE ${name} (id NUMBER(10) NOT NULL, label VARCHAR2(40))`,
    dropSql: name => `DROP TABLE ${name}`,
  },
];

for (const liveCase of cases) {
  const describeIfConfigured = liveCase.config ? describe : describe.skip;
  describeIfConfigured(`${liveCase.name} live DDL conformance`, () => {
    it('creates and drops a unique fixture using dialect DDL', async () => {
      const tableName = liveCase.tableName();
      const connection = liveCase.createConnection(liveCase.config!);
      let connected = false;
      let created = false;

      try {
        const statements = [liveCase.createSql(tableName), ...(liveCase.alterSql ? [liveCase.alterSql(tableName)] : [])];
        for (const sql of statements) {
          const parsed = parseSqlStatements({ databaseKind: liveCase.databaseKind, sql });
          expect(parsed.lexResult.errors).toHaveLength(0);
          expect(parsed.actionableParserErrors).toHaveLength(0);
          expect(parsed.cst).toBeDefined();
        }
        await connection.connect();
        connected = true;
        await connection.createCommand(liveCase.createSql(tableName)).execute();
        created = true;
        if (liveCase.alterSql) {
          await connection.createCommand(liveCase.alterSql(tableName)).execute();
        }
      } finally {
        try {
          if (connected && created) await connection.createCommand(liveCase.dropSql(tableName)).execute();
        } finally {
          await connection.close();
        }
      }
    }, 120_000);
  });
}
