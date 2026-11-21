import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { extractDatabaseErrorDetails } from '@justybase/database-runtime';

/**
 * Live PostgreSQL error-shape probe.
 *
 * This suite locks the fields the result panel and the runtime diagnostic rely
 * on: SQLSTATE, one-based position, DETAIL/HINT, and the PL/pgSQL CONTEXT line.
 * It uses a transaction and rolls everything back, so no durable objects are
 * created. Run explicitly with POSTGRES_LIVE_TEST_* configured.
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
  throw new Error('PostgreSQL error-field probe requires POSTGRES_LIVE_TEST_' + missing.join(', POSTGRES_LIVE_TEST_'));
}
const pg = createRequire(path.resolve('extensions/postgresql/package.json'))('pg') as PgModule;
const client = new pg.Client({
  host: process.env.POSTGRES_LIVE_TEST_HOST,
  database: process.env.POSTGRES_LIVE_TEST_DATABASE,
  user: process.env.POSTGRES_LIVE_TEST_USER,
  password: process.env.POSTGRES_LIVE_TEST_PASSWORD,
  port: Number(process.env.POSTGRES_LIVE_TEST_PORT || 5432),
  connectionTimeoutMillis: 10000,
  application_name: 'justybase-postgresql-error-fields',
});
const schema = 'jbe_' + randomUUID().replace(/-/g, '').slice(0, 16);
let connected = false;

async function capture(sql: string): Promise<Record<string, unknown>> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return error as Record<string, unknown>;
  }
  await client.query('ROLLBACK TO SAVEPOINT probe');
  throw new Error(`Expected the server to reject: ${sql}`);
}

describe('PostgreSQL error fields (transactional fixtures)', () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '", pg_catalog');
    await client.query('CREATE TABLE items(id integer PRIMARY KEY, payload text)');
    await client.query('INSERT INTO items VALUES (1, NULL)');
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await client.query('ROLLBACK');
      const remaining = await client.query('SELECT oid FROM pg_namespace WHERE nspname = $1', [schema]);
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('extracts SQLSTATE and a one-based position from a syntax error', async () => {
    const details = extractDatabaseErrorDetails(await capture('SELEC 1'));
    expect(details).toMatchObject({ code: '42601', severity: 'ERROR', position: 1 });
  });

  it('extracts constraint, schema and table from a unique violation', async () => {
    const details = extractDatabaseErrorDetails(await capture('INSERT INTO items VALUES (1, NULL)'));
    expect(details?.code).toBe('23505');
    expect(details?.detail).toContain('Key (id)=(1) already exists.');
    expect(details?.diagnostics?.schema).toBe(schema);
    expect(details?.diagnostics?.table).toBe('items');
    expect(details?.diagnostics?.constraint).toBe('items_pkey');
  });

  it('maps a PL/pgSQL runtime failure to CONTEXT and the internal query', async () => {
    await client.query(
      'CREATE FUNCTION f_missing() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT missing_col FROM items); END $$',
    );
    const details = extractDatabaseErrorDetails(await capture('SELECT f_missing()'));
    expect(details?.code).toBe('42703');
    expect(details?.context).toContain('PL/pgSQL function f_missing() line 1 at RETURN');
    expect(details?.diagnostics?.internalPosition).toBe('9');
    expect(details?.diagnostics?.internalQuery).toContain('missing_col');
  });

  it('keeps RAISE DETAIL and HINT', async () => {
    await client.query(
      "CREATE FUNCTION f_raise() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING DETAIL = 'some detail', HINT = 'some hint'; END $$",
    );
    const details = extractDatabaseErrorDetails(await capture('SELECT f_raise()'));
    expect(details).toMatchObject({ code: 'P0001', detail: 'some detail', hint: 'some hint' });
    expect(details?.context).toContain('PL/pgSQL function f_raise() line 1 at RAISE');
  });

  it('reports an absolute position for an invalid PL/pgSQL body', async () => {
    const details = extractDatabaseErrorDetails(await capture(
      'CREATE FUNCTION f_bad() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN SELEC 1; END $$',
    ));
    expect(details?.code).toBe('42601');
    expect(details?.position).toBeGreaterThan(0);
  });

  it('reports the end position for a missing END IF', async () => {
    const details = extractDatabaseErrorDetails(await capture(
      'CREATE FUNCTION f_struct() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN IF true THEN RETURN 1; END $$',
    ));
    expect(details?.code).toBe('42601');
    expect(details?.position).toBeGreaterThan(0);
    expect(details?.diagnostics?.routine).toBe('plpgsql_yyerror');
  });
});
