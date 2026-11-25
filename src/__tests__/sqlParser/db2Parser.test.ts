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
		[
			'create index with designer clauses',
			'CREATE UNIQUE INDEX JBL_LIVE.IDX_AMT ON JBL_LIVE.JBL_ORDERS (ORDER_ID ASC, AMOUNT DESC) INCLUDE (CUSTOMER_ID) ALLOW REVERSE SCANS COMPRESS YES PCTFREE 10 CLUSTER IN USERSPACE1',
		],
		[
			'drop index',
			'DROP INDEX JBL_LIVE.IDX_AMT',
		],
		[
			'rename table',
			'RENAME TABLE JBL_LIVE.T1 TO T2',
		],
		[
			'add partition',
			"ALTER TABLE JBL_LIVE.JBL_SALES_FACT ADD PARTITION P_2026 STARTING FROM ('2026-01-01') INCLUSIVE ENDING AT ('2027-01-01') EXCLUSIVE IN USERSPACE1",
		],
		[
			'attach partition',
			"ALTER TABLE JBL_LIVE.JBL_SALES_FACT ATTACH PARTITION P_2027 STARTING FROM ('2027-01-01') INCLUSIVE ENDING AT ('2028-01-01') EXCLUSIVE FROM TABLE JBL_LIVE.JBL_STAGE",
		],
		[
			'detach partition',
			'ALTER TABLE JBL_LIVE.JBL_SALES_FACT DETACH PARTITION P_2024 INTO JBL_LIVE.JBL_OLD',
		],
		[
			'reorg table',
			'REORG TABLE JBL_LIVE.JBL_ORDERS',
		],
		[
			'runstats',
			'RUNSTATS ON TABLE JBL_LIVE.JBL_ORDERS ON KEY COLUMNS AND INDEXES ALL',
		],
		[
			'create trigger',
			'CREATE TRIGGER JBL_LIVE.TRG AFTER INSERT ON JBL_LIVE.JBL_ORDERS REFERENCING NEW AS N FOR EACH ROW MODE DB2SQL BEGIN ATOMIC SET N.AMOUNT = 0; END',
		],
		[
			'label on table',
			"LABEL ON TABLE JBL_LIVE.JBL_ORDERS IS 'Orders'",
		],
		[
			'export',
			'EXPORT TO /tmp/orders.ixf OF IXF SELECT * FROM JBL_LIVE.JBL_ORDERS',
		],
		[
			'import',
			'IMPORT FROM /tmp/orders.ixf OF IXF INSERT INTO JBL_LIVE.JBL_ORDERS',
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

	it.each([
		['current schema', 'SELECT CURRENT SCHEMA FROM SYSIBM.SYSDUMMY1'],
		['current server', 'SELECT CURRENT SERVER AS DATABASE FROM SYSIBM.SYSDUMMY1 WITH UR'],
		['current user', 'SELECT CURRENT USER FROM SYSIBM.SYSDUMMY1'],
		['current time', 'SELECT CURRENT TIME FROM SYSIBM.SYSDUMMY1'],
		['current timestamp', 'SELECT CURRENT TIMESTAMP FROM SYSIBM.SYSDUMMY1'],
		['current date in predicate', 'SELECT ID FROM T WHERE TS > CURRENT DATE'],
		['values current schema', 'VALUES CURRENT SCHEMA'],
		['set current schema', 'SET CURRENT SCHEMA JBL_LIVE'],
		['set current isolation', 'SET CURRENT ISOLATION UR'],
		['set schema', 'SET SCHEMA JBL_LIVE'],
	])('parses the Db2 special register in %s', (_name, sql) => {
		const result = parse(sql);
		expect(result.lexResult.errors).toHaveLength(0);
		expect(result.actionableParserErrors).toHaveLength(0);
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

	it.each([
		[
			'IF / THEN / ELSE / END IF',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN IF a > 1 THEN SET a = 2; ELSE SET a = 3; END IF; END`,
		],
		[
			'CASE statement',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN CASE WHEN a > 1 THEN SET a = 2; ELSE SET a = 3; END CASE; END`,
		],
		[
			'WHILE / DO / END WHILE',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN WHILE a < 10 DO SET a = a + 1; END WHILE; END`,
		],
		[
			'REPEAT / UNTIL / END REPEAT',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN REPEAT SET a = a - 1; UNTIL a <= 0 END REPEAT; END`,
		],
		[
			'FOR loop',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN FOR r AS SELECT 1 AS x FROM SYSIBM.SYSDUMMY1 DO SET y = r.x; END FOR; END`,
		],
		[
			'nested compound statement',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN IF a > 1 THEN BEGIN SET a = 2; END; END IF; END`,
		],
		[
			'CASE expression inside a body statement',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN SET b = CASE WHEN a > 1 THEN 2 ELSE 3 END; END`,
		],
		[
			'DECLARE ... DEFAULT',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN DECLARE b INTEGER DEFAULT 0; SET b = 1; END`,
		],
		[
			'SIGNAL SQLSTATE',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN SIGNAL SQLSTATE '75000' SET MESSAGE_TEXT = 'boom'; END`,
		],
		[
			'DECLARE CONTINUE HANDLER',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET x = 1; END`,
		],
		[
			'COMMIT / ROLLBACK',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN COMMIT; ROLLBACK; END`,
		],
		[
			'cursor FETCH',
			`CREATE PROCEDURE p () LANGUAGE SQL BEGIN DECLARE c CURSOR FOR SELECT 1 FROM SYSIBM.SYSDUMMY1; OPEN c; FETCH c INTO x; CLOSE c; END`,
		],
		[
			'BETWEEN predicate',
			`CREATE PROCEDURE p (IN a INTEGER) LANGUAGE SQL BEGIN IF a BETWEEN 1 AND 5 THEN SET a = 0; END IF; END`,
		],
	])('parses the SQL PL construct %s', (_name, sql) => {
		const result = parse(sql);
		expect(result.lexResult.errors).toHaveLength(0);
		expect(result.actionableParserErrors).toHaveLength(0);
	});

	it('keeps the parser cheap to construct (self-analysis budget)', () => {
		const start = performance.now();
		createSqlParserInstance();
		// Db2 identifier handling accepts most keywords, so a statement
		// alternative that starts with a generic identifier makes Chevrotain's
		// self-analysis explode. Guard the budget that keeps activation fast.
		expect(performance.now() - start).toBeLessThan(2000);
	});

	it('creates an isolated parser instance', () => {
		const parser = createSqlParserInstance();
		expect(parser).toBeDefined();
	});
});
