jest.unmock('chevrotain');

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadSqlConformanceCases,
  resolveSqlConformanceRoot,
  selectPostgresqlCases,
} from '../sqlParser/sqlConformanceCorpus';
import { getPostgresqlVersionDiagnostics } from '../../dialects/postgresql/versionDiagnostics';

// Explicit local-only conformance probe: cases come from the sibling
// JustyBase.SqlConformance checkout via JUSTYBASE_SQL_CONFORMANCE_PATH.
const cases = selectPostgresqlCases(loadSqlConformanceCases(resolveSqlConformanceRoot()))
  .filter(testCase => testCase.contract === 'parser') as {
    id: string; sql: string; expect: { valid: boolean };
  }[];

interface LiveClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
interface PgModule { Client: new (config: Record<string, unknown>) => LiveClient }

const required = ['HOST', 'DATABASE', 'USER', 'PASSWORD'] as const;
const missing = required.filter(key => !process.env['POSTGRES_LIVE_TEST_' + key]);
if (missing.length) throw new Error('PostgreSQL conformance requires POSTGRES_LIVE_TEST_' + missing.join(', POSTGRES_LIVE_TEST_'));
const pg = createRequire(path.resolve('extensions/postgresql/package.json'))('pg') as PgModule;
const client = new pg.Client({
  host: process.env.POSTGRES_LIVE_TEST_HOST,
  database: process.env.POSTGRES_LIVE_TEST_DATABASE,
  user: process.env.POSTGRES_LIVE_TEST_USER,
  password: process.env.POSTGRES_LIVE_TEST_PASSWORD,
  port: Number(process.env.POSTGRES_LIVE_TEST_PORT || 5432),
  connectionTimeoutMillis: 10000,
  application_name: 'justybase-postgresql-conformance',
});
const schema = 'jbp_' + randomUUID().replace(/-/g, '');
const evidence: { id: string; accepted: boolean; sqlstate?: string; expected: boolean; inputHash: string; sqlHash: string; phase: string }[] = [];
let version: number;
let connected = false;
let cleanupVerified = false;

describe('PostgreSQL server conformance (transactional fixtures)', () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    version = Number((await client.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '", pg_catalog');
    await client.query('CREATE TABLE items(id integer PRIMARY KEY DEFAULT 100, payload text DEFAULT \'{}\')');
    await client.query('CREATE TABLE other(id integer PRIMARY KEY, payload text)');
    await client.query("INSERT INTO items VALUES(1, '{}')");
    await client.query("INSERT INTO other VALUES(1, '{}'), (2, '{}')");
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await client.query('ROLLBACK');
      cleanupVerified = (await client.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows.length === 0;
      expect(cleanupVerified).toBe(true);
    } finally {
      await client.end();
      const directory = path.resolve('artifacts/postgresql');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'conformance-' + version + '.json'),
        JSON.stringify({ version, cleanupVerified, cases: evidence }, null, 2) + '\n');
    }
  });

  it.each(cases)('$id', async testCase => {
    const fixtureName = 'jb_cf_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const probe = (testCase as { liveProbe?: { setup: string[] } }).liveProbe;
    const render = (source: string): string => source.replace(/\{\{cf\}\}/g, fixtureName)
      .replace(/\bpublic\./g, '"' + schema + '".');
    // Qualify only corpus fixture names; never use an existing public object.
    let sql = render(testCase.sql);
    // Planning proves syntax and binding without running unbounded recursive SELECTs.
    const phase = /^\s*(SELECT|WITH)\b/i.test(sql) ? 'plan' : 'execute';
    if (phase === 'plan') sql = 'EXPLAIN ' + sql;
    const expected = testCase.expect.valid && getPostgresqlVersionDiagnostics(testCase.sql, version).length === 0;
    await client.query('SAVEPOINT conformance_case');
    let accepted = false;
    let sqlstate: string | undefined;
    // Fixture failures must fail the test, never count as syntax rejection.
    let setupCompleted = false;
    try {
      for (const statement of probe?.setup ?? []) await client.query(render(statement));
      setupCompleted = true;
      await client.query(sql, /\$1\b/.test(sql) ? [1] : undefined);
      accepted = true;
    } catch (error) {
      sqlstate = (error as { code?: string }).code;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT conformance_case');
      await client.query('RELEASE SAVEPOINT conformance_case');
    }
    expect(setupCompleted).toBe(true);
    evidence.push({ id: testCase.id, accepted, sqlstate, expected,
      inputHash: createHash('sha256').update(testCase.sql).digest('hex'),
      sqlHash: createHash('sha256').update(sql).digest('hex'), phase });
    // Missing fixtures, privileges, timeouts or connectivity are never syntax evidence.
    if (!accepted) expect(testCase.id === 'postgresql.parser.bad-explain-format.001'
      ? ['22023'] : ['42601', '42P10', '0A000']).toContain(sqlstate);
    expect({ id: testCase.id, accepted, sqlstate: accepted ? undefined : sqlstate }).toEqual({
      id: testCase.id, accepted: expected, sqlstate: accepted ? undefined : sqlstate,
    });
  });
});
