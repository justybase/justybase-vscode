jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import { DB2_SQL_PARSING_RUNTIME, parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { createSqlParserInstance } from '../../dialects/db2/sql/parser';
import { SqlLexer } from '../../dialects/db2/sql/lexer';
import { db2SqlAuthoring } from '../../../extensions/db2/src/sql/authoring';

function parse(sql: string) {
	return parseSqlStatements({ sql, runtime: DB2_SQL_PARSING_RUNTIME });
}

describe('Db2SqlParser LUW', () => {
	it('tokenizes Db2 isolation, OPTIMIZE FOR, and FOR READ ONLY phrases', () => {
		const result = SqlLexer.tokenize(
			'SELECT 1 FROM T OPTIMIZE FOR 10 ROWS FOR READ ONLY WITH UR',
		);
		expect(result.errors).toHaveLength(0);
		expect(result.tokens.map((token) => token.tokenType.name)).toEqual(
			expect.arrayContaining([
				'Db2OptimizeFor',
				'Db2ForReadOnly',
				'Db2WithUr',
			]),
		);
	});

	it('tokenizes CURRENT SCHEMA / CURRENT DATE phrases', () => {
		const result = SqlLexer.tokenize('SELECT CURRENT DATE FROM SYSIBM.SYSDUMMY1 WHERE CURRENT SCHEMA = X');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens.some((token) => token.tokenType.name === 'Db2CurrentDate')).toBe(true);
		expect(result.tokens.some((token) => token.tokenType.name === 'Db2CurrentSchema')).toBe(true);
	});

	it('parses FETCH FIRST and WITH UR via authoring runtime', () => {
		const parsed = parseSqlStatements({
			sql: 'SELECT ID FROM JBL_LIVE.JBL_ORDERS FETCH FIRST 5 ROWS ONLY WITH UR',
			authoring: db2SqlAuthoring,
			databaseKind: 'db2',
		});
		expect(parsed.runtime.id).toBe('db2');
		expect(parsed.actionableParserErrors).toHaveLength(0);
		expect(parsed.cst).toBeDefined();
	});

	it.each([
		[
			'optimize + isolation',
			'SELECT ID FROM T ORDER BY ID FETCH FIRST 5 ROWS ONLY OPTIMIZE FOR 5 ROWS WITH UR',
		],
		[
			'for read only',
			'SELECT ID FROM T FETCH FIRST 1 ROW ONLY FOR READ ONLY WITH CS',
		],
		[
			'merge into',
			'MERGE INTO target AS T USING source AS S ON (T.id = S.id) WHEN MATCHED THEN UPDATE SET T.v = S.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (S.id, S.v)',
		],
		[
			'cte',
			'WITH sales AS (SELECT id FROM orders) SELECT id FROM sales',
		],
		[
			'values insert',
			'INSERT INTO T (A, B) VALUES (1, \'x\'), (2, \'y\')',
		],
		[
			'declare global temporary table',
			'DECLARE GLOBAL TEMPORARY TABLE SESSION.TMP1 (ID INTEGER) ON COMMIT PRESERVE ROWS',
		],
		[
			'create alias',
			'CREATE ALIAS APP.ORDERS_A FOR APP.ORDERS',
		],
		[
			'create nickname',
			'CREATE NICKNAME APP.REMOTE_ORDERS FOR FEDSERVER.REMOTE_SCHEMA.ORDERS',
		],
		[
			'create table basic',
			'CREATE TABLE T (ID INTEGER NOT NULL, NAME VARCHAR(40))',
		],
		[
			'final table source',
			'SELECT * FROM FINAL TABLE (INSERT INTO T (ID) VALUES (1))',
		],
	])('parses %s without actionable errors', (_name, sql) => {
		const result = parse(sql);
		expect(result.lexResult.errors).toHaveLength(0);
		expect(result.actionableParserErrors).toHaveLength(0);
		expect(result.cst).toBeDefined();
	});

	it.each([
		'SELECT * FROM T LIMIT 1',
		'SELECT * FROM DB..TABLE',
		'GROOM TABLE sales VERSIONS',
		'GENERATE STATISTICS ON sales',
		'CREATE TABLE t (a INT) DISTRIBUTE ON (a)',
		'CREATE EXTERNAL TABLE ext_sales (id INT)',
		'CREATE SYNONYM APP.ORDERS_S FOR APP.ORDERS',
	])('rejects Netezza-only or non-Db2 synonym syntax: %s', (sql) => {
		const result = parse(sql);
		expect(result.actionableParserErrors.length).toBeGreaterThan(0);
	});

	it('parses LANGUAGE SQL procedure units as one CST statement', () => {
		const result = parse(`CREATE OR REPLACE PROCEDURE demo_proc (IN p_in INTEGER, OUT p_out INTEGER)
LANGUAGE SQL
BEGIN
  SET p_out = p_in;
END`);
		expect(result.lexResult.errors).toHaveLength(0);
		expect(result.actionableParserErrors).toHaveLength(0);
		expect(result.cst).toBeDefined();
	});

	it('creates an isolated parser instance', () => {
		const parser = createSqlParserInstance();
		expect(parser).toBeDefined();
	});
});
