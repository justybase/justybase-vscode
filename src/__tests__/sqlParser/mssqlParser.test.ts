jest.unmock('chevrotain');

import { describe, expect, it } from '@jest/globals';
import { MSSQL_SQL_PARSING_RUNTIME, parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { createSqlParserInstance } from '../../dialects/mssql/sql/parser';
import { SqlLexer } from '../../dialects/mssql/sql/lexer';
import { mssqlSqlAuthoring } from '../../../extensions/mssql/src/sql/authoring';

function parse(sql: string) {
	return parseSqlStatements({ sql, runtime: MSSQL_SQL_PARSING_RUNTIME });
}

describe('MsSqlSqlParser T-SQL', () => {
	it('tokenizes TOP, APPLY, OUTPUT, and bracketed identifiers', () => {
		const result = SqlLexer.tokenize(
			'SELECT TOP (10) [Id] FROM dbo.T CROSS APPLY dbo.f(x) OUTPUT inserted.Id',
		);
		expect(result.errors).toHaveLength(0);
		expect(result.tokens.map((token) => token.tokenType.name)).toEqual(
			expect.arrayContaining([
				'MsSqlTop',
				'MsSqlBracketedIdentifier',
				'MsSqlCrossApply',
				'MsSqlOutput',
			]),
		);
	});

	it('tokenizes T-SQL variables', () => {
		const result = SqlLexer.tokenize('SELECT @id, @@SPID');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens.filter((token) => token.tokenType.name === 'MsSqlVariable')).toHaveLength(2);
	});

	it('parses TOP and OFFSET/FETCH via authoring runtime', () => {
		const parsed = parseSqlStatements({
			sql: 'SELECT TOP 5 Id FROM dbo.Orders ORDER BY Id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
			authoring: mssqlSqlAuthoring,
			databaseKind: 'mssql',
		});
		expect(parsed.runtime.id).toBe('mssql');
		expect(parsed.actionableParserErrors).toHaveLength(0);
		expect(parsed.cst).toBeDefined();
	});

	it.each([
		[
			'top percent with ties',
			'SELECT TOP (10) PERCENT WITH TIES Id FROM dbo.T ORDER BY Id',
		],
		[
			'cross apply',
			'SELECT t.Id, x.v FROM dbo.T AS t CROSS APPLY (SELECT 1 AS v) AS x',
		],
		[
			'outer apply',
			'SELECT t.Id FROM dbo.T AS t OUTER APPLY (SELECT 1 AS v) AS f',
		],
		[
			'bracketed names',
			'SELECT [Order Id] FROM [dbo].[Orders]',
		],
		[
			'update output',
			'UPDATE dbo.T SET V = 1 OUTPUT inserted.Id WHERE Id = 1',
		],
		[
			'delete output',
			'DELETE FROM dbo.T OUTPUT deleted.Id WHERE Id = 1',
		],
		[
			'insert output',
			'INSERT INTO dbo.T (Id) OUTPUT inserted.Id VALUES (1)',
		],
		[
			'variable in select',
			'SELECT @x FROM dbo.T',
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
			'go batch',
			'GO',
		],
		[
			'begin end',
			'BEGIN SELECT 1 END',
		],
		[
			'begin end predicate keywords',
			'BEGIN SELECT * FROM t WHERE a IS NULL AND b = 1; END',
		],
		[
			'create procedure thin',
			'CREATE PROCEDURE demo_proc AS BEGIN SELECT 1 END',
		],
		[
			'create procedure parameters',
			'CREATE PROCEDURE demo_proc @id INT = 1, @name NVARCHAR(20) OUTPUT AS SELECT @id',
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
		'CREATE TABLE t (a INT) DISTRIBUTE ON (a)',
	])('rejects Netezza-only syntax: %s', (sql) => {
		const result = parse(sql);
		expect(result.actionableParserErrors.length).toBeGreaterThan(0);
	});

	it('creates an isolated parser instance', () => {
		const parser = createSqlParserInstance();
		expect(parser).toBeDefined();
	});
});
