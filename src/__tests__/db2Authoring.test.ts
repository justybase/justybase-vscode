import { describe, expect, it } from '@jest/globals';
import { getDatabaseSqlAuthoring } from '../core/sqlAuthoringRegistry';
import { resolveSqlParsingRuntime } from '../sqlParser/parsingRuntime';

describe('Db2 SQL authoring', () => {
	it('exposes Db2 types, built-ins, signatures and static assets', () => {
		const authoring = getDatabaseSqlAuthoring('db2');

		expect(authoring.validation.getTypeSpec('DECFLOAT')?.canonical).toBe('DECFLOAT');
		expect(authoring.validation.getTypeSpec('VARCHAR')?.warnIfNoLength).toBe(true);
		expect(authoring.validation.getTypeSpec('CHARACTER VARYING(40)')?.canonical).toBe('VARCHAR');
		expect(authoring.validation.builtinFunctions.has('COALESCE')).toBe(true);
		expect(authoring.validation.syntaxValidationMode).toBe('strict');
		expect(authoring.signatures.get('COUNT')?.[0].parameters).toEqual(['expression']);
		expect(authoring.qualityRules.map((rule) => rule.id)).toEqual([
			'DB2001',
			'DB2002',
			'DB2003',
			'DB2004',
			'DB2005',
			'DB2006',
			'DB2007',
			'DB2008',
		]);
		expect(authoring.staticAssets?.grammarPath).toBe('dialects/db2/syntaxes/db2.tmLanguage.json');
		expect(authoring.parsing?.parserModulePath).toBe('src/dialects/db2/sql/parser.ts');
	});

	it('registers the dedicated Db2 parsing runtime', () => {
		const runtime = resolveSqlParsingRuntime({
			authoring: getDatabaseSqlAuthoring('db2'),
			databaseKind: 'db2',
		});
		expect(runtime.id).toBe('db2');
	});

	it('does not register Netezza-only NZ/NZP quality rules', () => {
		const authoring = getDatabaseSqlAuthoring('db2');
		expect(authoring.qualityRules.some((rule) => rule.id.startsWith('NZ'))).toBe(false);
	});

	it('runs Db2 safety rules for destructive DML and Netezza carry-overs', () => {
		const rules = getDatabaseSqlAuthoring('db2').qualityRules;
		const issues = rules.flatMap((rule) =>
			rule.check(
				"DELETE FROM ORDERS; UPDATE ORDERS SET STATUS = 1; SELECT * FROM ORDERS FETCH FIRST 10 ROWS ONLY; SELECT * FROM T LIMIT 5; SELECT * FROM DB..T;",
			),
		);

		expect(issues.map((issue) => issue.ruleId)).toEqual(
			expect.arrayContaining(['DB2001', 'DB2002', 'DB2003', 'DB2006', 'DB2007', 'DB2008']),
		);
	});
});
