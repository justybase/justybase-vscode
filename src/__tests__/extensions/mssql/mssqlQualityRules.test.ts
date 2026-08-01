import { describe, expect, it } from '@jest/globals';
import {
	mssqlSqlQualityRules,
	ruleMSS001,
	ruleMSS002,
	ruleMSS006,
	ruleMSS007,
	ruleMSS008,
} from '../../../../extensions/mssql/src/sql/qualityRules';
import { mssqlSqlAuthoring } from '../../../../extensions/mssql/src/sql/authoring';

describe('MSSQL quality rules', () => {
	it('registers MSS001–MSS008 on authoring', () => {
		expect(mssqlSqlAuthoring.qualityRules?.map((rule) => rule.id)).toEqual([
			'MSS001',
			'MSS002',
			'MSS003',
			'MSS004',
			'MSS005',
			'MSS006',
			'MSS007',
			'MSS008',
		]);
		expect(mssqlSqlAuthoring.validation.syntaxValidationMode).toBe('strict');
		expect(mssqlSqlQualityRules).toHaveLength(8);
	});

	it('flags SELECT *', () => {
		const issues = ruleMSS001.check('SELECT * FROM dbo.T');
		expect(issues.some((issue) => issue.ruleId === 'MSS001')).toBe(true);
	});

	it('flags DELETE without WHERE', () => {
		const issues = ruleMSS002.check('DELETE FROM dbo.T');
		expect(issues.some((issue) => issue.ruleId === 'MSS002')).toBe(true);
	});

	it('flags TOP without ORDER BY', () => {
		const issues = ruleMSS006.check('SELECT TOP 10 Id FROM dbo.T');
		expect(issues.some((issue) => issue.ruleId === 'MSS006')).toBe(true);
	});

	it('flags Netezza LIMIT and DB..TABLE', () => {
		expect(ruleMSS007.check('SELECT * FROM T LIMIT 5').length).toBeGreaterThan(0);
		expect(ruleMSS008.check('SELECT * FROM DB..TABLE').length).toBeGreaterThan(0);
	});
});
