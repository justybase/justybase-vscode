jest.unmock('chevrotain');

import {
  parseSqlStatements,
  POSTGRESQL_SQL_PARSING_RUNTIME,
  resolveSqlParsingRuntime,
} from '../../sqlParser/parsingRuntime';
import { SqlParser } from '../../sql/sqlParser';
import { buildSqlSourceScanIndex } from '@justybase/sql-core/sourceScan';
import { createSqlParserInstance } from '../../dialects/postgresql/sql/parser';
import { postgresqlSqlAuthoring } from '../../../extensions/postgresql/src/postgresqlSqlAuthoring';

function parse(sql: string) {
  return parseSqlStatements({ sql, databaseKind: 'postgresql' });
}

describe('PostgreSQL parser runtime', () => {
  it('registers a strict, PostgreSQL-specific runtime', () => {
    expect(resolveSqlParsingRuntime({ databaseKind: 'postgresql' })).toBe(POSTGRESQL_SQL_PARSING_RUNTIME);
    expect(postgresqlSqlAuthoring.validation.syntaxValidationMode).toBe('strict');
  });

  it.each([
    'SELECT DISTINCT ON (id) id FROM public.items ORDER BY id',
    'SELECT * FROM public.items i CROSS JOIN LATERAL (SELECT i.id) x',
    'WITH RECURSIVE tree AS (SELECT id FROM public.items UNION ALL SELECT id FROM tree) SELECT * FROM tree',
    'SELECT payload->>\'name\' FROM public.items',
    'SELECT payload::jsonb FROM public.items',
    'SELECT ARRAY[1, 2, 3]::integer[] FROM public.items',
    'INSERT INTO public.items (id, payload) VALUES (1, \'{}\') ON CONFLICT (id) DO NOTHING RETURNING id',
    'INSERT INTO public.items (id, payload) VALUES (1, \'{}\') ON CONFLICT (id) DO UPDATE SET payload = \'{}\' RETURNING id',
    'UPDATE public.items SET payload = \'{}\' WHERE id = 1 RETURNING id',
    'DELETE FROM public.items WHERE id = 1 RETURNING id',
    'CREATE FUNCTION public.add_one(x integer) RETURNS integer LANGUAGE sql AS $$ SELECT x + 1 $$',
    'CREATE OR REPLACE FUNCTION public.f() RETURNS TABLE(id integer, payload text) LANGUAGE sql AS $$ SELECT id, payload FROM public.items $$',
    'CREATE FUNCTION public.f() RETURNS integer[] LANGUAGE sql AS $$ SELECT ARRAY[1] $$',
    'CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ IMMUTABLE STRICT PARALLEL SAFE',
    'CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp COST 10 ROWS 100 AS $$ SELECT 1 $$',
    'CREATE PROCEDURE public.p(VARIADIC ys text[]) LANGUAGE plpgsql AS $$ BEGIN NULL; END $$',
    'CREATE INDEX idx ON public.items USING gin (payload jsonb_path_ops (fastupdate = on))',
    "SELECT * FROM JSON_TABLE('{\"a\":[{\"b\":1}]}', '$' COLUMNS (a json PATH '$.a', NESTED PATH '$.a[*]' COLUMNS (b integer PATH '$.b'))) jt",
  ])('accepts common PostgreSQL syntax: %s', sql => {
    const result = parse(sql);
    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
  });

  it.each([
    'SELECT * FROM db..items',
    'CREATE TABLE public.items (id integer) DISTRIBUTE ON (id)',
    'GROOM TABLE public.items',
  ])('rejects Netezza-only or non-PostgreSQL syntax: %s', sql => {
    expect(parse(sql).actionableParserErrors.length).toBeGreaterThan(0);
  });

  it.each([
    'CREATE FUNCTION public.f() LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE PROCEDURE public.p() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE FUNCTION public.f() RETURNS TABLE() LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE FUNCTION public.f() RETURNS TABLE(id) LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE FUNCTION public.f() RETURNS integer SET search_path = LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql',
    "SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (NESTED PATH '$.a' COLUMNS ())) jt",
  ])('rejects malformed PostgreSQL routine and JSON_TABLE syntax: %s', sql => {
    expect(parse(sql).actionableParserErrors.length).toBeGreaterThan(0);
  });

  it('keeps semicolons, comments and macro-looking text inside dollar bodies', () => {
    const sql = "SELECT $tag$a;b; -- $tag$; SELECT 2;";
    const statements = SqlParser.splitStatementsWithPositions(sql, 'postgresql');
    expect(statements.map(s => s.sql)).toEqual(["SELECT $tag$a;b; -- $tag$", "SELECT 2"]);
    for (const s of statements) expect(sql.slice(s.startOffset, s.endOffset)).toBe(s.sql);
    const scan = buildSqlSourceScanIndex(sql, 'postgresql');
    expect(scan.isInString(sql.indexOf('a;b'))).toBe(true);
    expect(scan.sanitized.length).toBe(sql.length);
  });
  it('keeps escaped quotes and unterminated bodies out of subsequent statements', () => {
    expect(SqlParser.splitStatements(String.raw`SELECT E'a\';b'; SELECT 2;`, 'postgresql')).toHaveLength(2);
    expect(SqlParser.splitStatements('SELECT $x$a;b; SELECT 2;', 'postgresql')).toHaveLength(1);
  });
  it('creates an independent parser below the construction budget', () => {
    const start = performance.now();
    expect(createSqlParserInstance()).toBeDefined();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
