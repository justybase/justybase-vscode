jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import {
  DUCKDB_SQL_PARSING_RUNTIME,
  parseSqlStatements,
  resolveSqlParsingRuntime,
} from '../../sqlParser/parsingRuntime';
import { SqlLexer } from '../../dialects/duckdb/sql/lexer';

function parse(sql: string) {
  return parseSqlStatements({ sql, runtime: DUCKDB_SQL_PARSING_RUNTIME });
}

describe('DuckDbSqlParser', () => {
  it('tokenizes DuckDB-specific keywords', () => {
    const result = SqlLexer.tokenize(
      'SELECT * FROM t QUALIFY row_number() OVER () = 1 ASOF JOIN u ON t.id = u.id',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.tokens.map((token) => token.tokenType.name)).toEqual(
      expect.arrayContaining(['DuckDbQualify', 'DuckDbAsOf']),
    );
  });

  it.each([
    ['qualify', 'SELECT * FROM t QUALIFY row_number() OVER () = 1'],
    ['star exclude', 'SELECT * EXCLUDE (secret, internal_id) FROM t'],
    ['star replace', 'SELECT * REPLACE (amount * 2 AS amount) FROM t'],
    ['star rename', 'SELECT * RENAME (amount AS total_amount) FROM t'],
    ['columns star exclude', 'SELECT min(COLUMNS(* EXCLUDE (id))) FROM t'],
    ['sample', 'SELECT * FROM t USING SAMPLE reservoir(10%)'],
    ['documented sample method', 'SELECT * FROM t USING SAMPLE 10 PERCENT (bernoulli)'],
    ['sample repeatable', 'SELECT * FROM t, u WHERE t.id = u.id USING SAMPLE 20% (system, 377) REPEATABLE (100)'],
    ['table sample', 'SELECT * FROM t TABLESAMPLE 10%'],
    ['asof join', 'SELECT * FROM trades ASOF JOIN prices ON trades.ts >= prices.ts'],
    ['positional join', 'SELECT * FROM left_table POSITIONAL JOIN right_table'],
    ['semi join', 'SELECT * FROM city_airport SEMI JOIN airport_names USING (iata)'],
    ['anti join', 'SELECT * FROM city_airport ANTI JOIN airport_names USING (iata)'],
    ['lateral join source', 'SELECT * FROM range(3) t(i), LATERAL (SELECT i + 1) t2(j)'],
    ['table function', "SELECT * FROM read_parquet('data.parquet')"],
    ['range table function', 'SELECT * FROM range(100)'],
    ['table function ordinality', "SELECT * FROM read_csv('data.csv') WITH ORDINALITY"],
    ['file source', "SELECT * FROM 'data.parquet'"],
    ['create macro', 'CREATE MACRO add_one(x) AS x + 1'],
    ['create or replace macro', 'CREATE OR REPLACE MACRO add_one(x) AS x + 1'],
    ['create function alias', 'CREATE FUNCTION add_one(x INTEGER := 1) AS x + 1'],
    ['temporary macro', 'CREATE OR REPLACE TEMPORARY MACRO add_one(x) AS x + 1'],
    ['macro if not exists', 'CREATE MACRO IF NOT EXISTS add_one(x) AS x + 1'],
    ['install', "INSTALL 'httpfs'"],
    ['load', "LOAD 'httpfs'"],
    ['attach', "ATTACH 'other.db' AS other"],
    ['detach', 'DETACH other'],
    ['use database', 'USE other'],
    ['pivot', 'PIVOT sales ON month USING sum(amount) GROUP BY region'],
    ['unpivot', 'UNPIVOT sales ON jan, feb INTO NAME month VALUE amount'],
    ['pivot wider alias', 'PIVOT_WIDER sales ON month USING sum(amount) GROUP BY region'],
    ['pivot standard', 'SELECT * FROM sales PIVOT (sum(amount) FOR month IN (1, 2))'],
    ['unpivot standard', 'FROM sales UNPIVOT (amount FOR month IN (jan, feb))'],
    ['create type', 'CREATE TYPE mood AS ENUM (\'sad\', \'ok\', \'happy\')'],
    ['create or replace type', 'CREATE OR REPLACE TYPE mood AS ENUM (\'sad\', \'ok\')'],
    ['create or replace table', 'CREATE OR REPLACE TABLE t AS SELECT 1 AS id'],
    ['nested struct type', 'CREATE TABLE t (payload STRUCT(id INTEGER, name VARCHAR))'],
    ['nested list type', 'CREATE TABLE t (payload ARRAY(STRUCT(id INTEGER)))'],
    ['map type', 'CREATE TABLE t (payload MAP(VARCHAR, INTEGER))'],
    ['from first query', 'FROM read_parquet(\'data.parquet\') SELECT * LIMIT ALL'],
    ['from first window qualify', 'FROM t SELECT row_number() OVER w AS rn WINDOW w AS (ORDER BY id) QUALIFY rn = 1'],
    ['union by name', 'SELECT 1 AS id UNION BY NAME SELECT 2 AS id'],
    ['union all by name', 'SELECT 1 AS id UNION ALL BY NAME SELECT 2 AS id'],
    ['intersect all', 'SELECT 1 INTERSECT ALL SELECT 1'],
    ['except all', 'SELECT 1 EXCEPT ALL SELECT 2'],
    ['ignore nulls', 'SELECT first(value IGNORE NULLS) FROM t'],
  ])('parses %s without actionable errors', (_name, sql) => {
    const result = parse(sql);

    expect(result.lexResult.errors).toHaveLength(0);
    expect(result.actionableParserErrors).toHaveLength(0);
    expect(result.cst).toBeDefined();
  });

  it('resolves the DuckDB runtime for DuckDB and File SQL', () => {
    expect(resolveSqlParsingRuntime({ databaseKind: 'duckdb' }).id).toBe('duckdb');
    expect(resolveSqlParsingRuntime({ databaseKind: 'file' }).id).toBe('duckdb');
  });

  it('does not accept Netezza DB..TABLE notation', () => {
    const result = parse('SELECT * FROM DB..TABLE');

    expect(result.actionableParserErrors.length).toBeGreaterThan(0);
  });
});
