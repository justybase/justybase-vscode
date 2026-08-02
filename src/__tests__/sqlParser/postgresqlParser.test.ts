jest.unmock('chevrotain');

import {
  parseSqlStatements,
  POSTGRESQL_SQL_PARSING_RUNTIME,
  resolveSqlParsingRuntime,
} from '../../sqlParser/parsingRuntime';
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
});
