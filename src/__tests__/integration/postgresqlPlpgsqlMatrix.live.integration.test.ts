jest.unmock('chevrotain');

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { SqlLexer } from '../../dialects/postgresql/sql/lexer';
import { getPostgresqlPlpgsqlDiagnostics } from '../../dialects/postgresql/plpgsql/postgresqlPlpgsqlDiagnostics';
import { POSTGRESQL_PLPGSQL_MATRIX_CASES } from '../sqlParser/postgresqlPlpgsqlMatrixCases';

/**
 * Live structural matrix for PL/pgSQL.
 *
 * Every case is compiled by the server inside a transaction and rolled back.
 * The suite also compares the static analyzer verdict with the corpus, so the
 * warning rules cannot silently drift away from server behaviour.
 */

interface LiveClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
interface PgModule { Client: new (config: Record<string, unknown>) => LiveClient }

const required = ['HOST', 'DATABASE', 'USER', 'PASSWORD'] as const;
const missing = required.filter(key => !process.env['POSTGRES_LIVE_TEST_' + key]);
if (missing.length) {
  throw new Error('PostgreSQL PL/pgSQL matrix requires POSTGRES_LIVE_TEST_' + missing.join(', POSTGRES_LIVE_TEST_'));
}
const pg = createRequire(path.resolve('extensions/postgresql/package.json'))('pg') as PgModule;
const client = new pg.Client({
  host: process.env.POSTGRES_LIVE_TEST_HOST,
  database: process.env.POSTGRES_LIVE_TEST_DATABASE,
  user: process.env.POSTGRES_LIVE_TEST_USER,
  password: process.env.POSTGRES_LIVE_TEST_PASSWORD,
  port: Number(process.env.POSTGRES_LIVE_TEST_PORT || 5432),
  connectionTimeoutMillis: 10000,
  application_name: 'justybase-postgresql-plpgsql-matrix',
});
const schema = 'jbm_' + randomUUID().replace(/-/g, '').slice(0, 16);
let connected = false;
let sequence = 0;

describe('PostgreSQL PL/pgSQL structural matrix (transactional fixtures)', () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '", pg_catalog');
    await client.query('CREATE TABLE items(id integer PRIMARY KEY, payload text)');
    await client.query("INSERT INTO items VALUES (1, 'a')");
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await client.query('ROLLBACK');
      expect((await client.query('SELECT oid FROM pg_namespace WHERE nspname = $1', [schema])).rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it.each(POSTGRESQL_PLPGSQL_MATRIX_CASES)('$id', async testCase => {
    const name = `f_${sequence++}`;
    const sql = testCase.sql.split('{{fn}}').join(name);
    const staticCodes = getPostgresqlPlpgsqlDiagnostics(sql, SqlLexer.tokenize(sql).tokens)
      .map(diagnostic => diagnostic.code);
    expect(staticCodes.sort()).toEqual([...testCase.codes].sort());

    await client.query('SAVEPOINT matrix');
    let serverError: Record<string, unknown> | undefined;
    try {
      await client.query(sql);
    } catch (error) {
      serverError = error as Record<string, unknown>;
    }

    try {
      if (testCase.valid) {
        expect(serverError).toBeUndefined();
        if (testCase.runtimeRejects) {
          await expect(client.query(`SELECT public.${name}()`)).rejects.toMatchObject({ code: '2F005' });
        }
      } else {
        expect(serverError?.code).toBe('42601');
      }
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT matrix');
    }
  });
});
