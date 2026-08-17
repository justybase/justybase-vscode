import { describe, expect, it } from '@jest/globals';
import { LintSeverity } from '../../providers/linterRules';
import {
	createDeleteFromPattern,
	createDeleteWithoutWhereRule,
	createDoubleDotTableRule,
	createIdentifierPattern,
	createKeywordRule,
	createRownumWithOrderByRule,
	createSelectStarRule,
	createStatementEndScanner,
	createTopNWithoutOrderByRule,
	createUpdateSetPattern,
	createUpdateWithoutWhereRule,
} from '../../providers/qualityRuleFactory';

const plainScanner = createStatementEndScanner();
const bracketScanner = createStatementEndScanner({ brackets: true });
const qQuoteScanner = createStatementEndScanner({ oracleQQuote: true });

describe('createStatementEndScanner', () => {
	it('finds the terminating semicolon in a plain statement', () => {
		const sql = 'UPDATE T SET X = 1 WHERE ID = 5; SELECT 1';
		expect(plainScanner(sql, 0)).toBe(sql.indexOf(';'));
	});

	it('ignores semicolons inside string literals and comments', () => {
		const sql = "DELETE FROM T WHERE NOTE = 'a;b'; -- ;\n;";
		expect(plainScanner(sql, 0)).toBe(sql.indexOf("';") + 1);
	});

	it('tracks MSSQL bracket identifiers (brackets option)', () => {
		const sql = "DELETE FROM [dbo].[T] WHERE [X] = ']'; SELECT 1";
		expect(bracketScanner(sql, 0)).toBe(sql.indexOf("';") + 1);
	});

	it('does not mistake a bracket for a string terminator (brackets option)', () => {
		const sql = 'DELETE FROM [dbo].[T];';
		expect(bracketScanner(sql, 0)).toBe(sql.indexOf(';'));
	});

	it('tracks Oracle q-quoted literals (oracleQQuote option)', () => {
		const sql = "DELETE FROM T WHERE N = q'[x;y]'; SELECT 1";
		expect(qQuoteScanner(sql, 0)).toBe(sql.lastIndexOf(';'));
	});

	it('falls back to end of input when no semicolon exists', () => {
		expect(plainScanner('UPDATE T SET X = 1', 0)).toBe(18);
	});
});

describe('identifier / statement patterns', () => {
	const deleteRule = createDeleteWithoutWhereRule({
		id: 'T020',
		name: 'Delete Without Where',
		description: 'desc',
		defaultSeverity: LintSeverity.Error,
		statementEnd: plainScanner,
		targetPattern: createDeleteFromPattern(createIdentifierPattern()),
	});

	it('builds plain identifier patterns', () => {
		expect(deleteRule.check('DELETE FROM SCHEMA.TABLE')).toHaveLength(1);
		expect(deleteRule.check('DELETE FROM "My Schema".TABLE')).toHaveLength(1);
	});

	it('builds bracketed identifier patterns for MSSQL', () => {
		const rule = createUpdateWithoutWhereRule({
			id: 'T021',
			name: 'Update Without Where',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
			statementEnd: bracketScanner,
			targetPattern: createUpdateSetPattern(createIdentifierPattern({ brackets: true })),
		});
		expect(rule.check('UPDATE [T] SET X = 1')).toHaveLength(1);
		expect(rule.check('UPDATE [dbo].[T] SET X = 1')).toHaveLength(1);

		const deleteRule = createDeleteWithoutWhereRule({
			id: 'T022',
			name: 'Delete Without Where',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
			statementEnd: bracketScanner,
			targetPattern: createDeleteFromPattern(createIdentifierPattern({ brackets: true })),
		});
		expect(deleteRule.check('DELETE FROM [dbo].[T]')).toHaveLength(1);
	});

	it('builds DELETE/UPDATE patterns case-insensitively', () => {
		expect(deleteRule.check('delete from t')).toHaveLength(1);
	});
});

describe('rule factories', () => {
	it('createSelectStarRule points the issue at the star', () => {
		const rule = createSelectStarRule({
			id: 'T001',
			name: 'Select Star',
			description: 'desc',
			defaultSeverity: LintSeverity.Warning,
			selectStarPattern: /\bSELECT\s+\*/gi,
		});
		const issues = rule.check('SELECT * FROM T');
		expect(issues).toHaveLength(1);
		expect(issues[0].ruleId).toBe('T001');
		expect(issues[0].message).toBe('T001: desc');
		expect(issues[0].severity).toBe(LintSeverity.Warning);
		expect(issues[0].startOffset).toBe(7);
		expect(issues[0].endOffset).toBe(8);
	});

	it('createDeleteWithoutWhereRule flags DELETE without WHERE', () => {
		const rule = createDeleteWithoutWhereRule({
			id: 'T002',
			name: 'Delete Without Where',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
			statementEnd: plainScanner,
			targetPattern: createDeleteFromPattern(createIdentifierPattern()),
		});
		expect(rule.check('DELETE FROM T; DELETE FROM T WHERE ID = 1')).toHaveLength(1);
		expect(rule.check('DELETE FROM T')[0].startOffset).toBe(0);
		expect(rule.check('DELETE FROM T')[0].endOffset).toBe(6);
	});

	it('createUpdateWithoutWhereRule flags UPDATE without WHERE', () => {
		const rule = createUpdateWithoutWhereRule({
			id: 'T003',
			name: 'Update Without Where',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
			statementEnd: plainScanner,
			targetPattern: createUpdateSetPattern(createIdentifierPattern()),
		});
		expect(rule.check('UPDATE T SET X = 1')).toHaveLength(1);
		expect(rule.check('UPDATE T SET X = 1 WHERE ID = 1')).toHaveLength(0);
	});

	it('createKeywordRule reports the full match range', () => {
		const rule = createKeywordRule({
			id: 'T004',
			name: 'Keyword',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
			keywordPattern: /\bGROOM\b/gi,
		});
		const issues = rule.check('GROOM TABLE T');
		expect(issues).toHaveLength(1);
		expect(issues[0].startOffset).toBe(0);
		expect(issues[0].endOffset).toBe(5);
	});

	it('createDoubleDotTableRule flags DB..TABLE', () => {
		const rule = createDoubleDotTableRule({
			id: 'T005',
			name: 'Double Dot',
			description: 'desc',
			defaultSeverity: LintSeverity.Error,
		});
		expect(rule.check('SELECT * FROM DB..TABLE')).toHaveLength(1);
	});

	it('createTopNWithoutOrderByRule requires ORDER BY in the same statement', () => {
		const rule = createTopNWithoutOrderByRule({
			id: 'T006',
			name: 'Top-N',
			description: 'desc',
			defaultSeverity: LintSeverity.Warning,
			statementEnd: plainScanner,
			topNPattern: /\b(?:FETCH\s+(?:FIRST|NEXT)|OPTIMIZE\s+FOR)\b/gi,
		});
		expect(rule.check('SELECT * FROM T FETCH FIRST 5 ROWS ONLY')).toHaveLength(1);
		expect(rule.check('SELECT * FROM T ORDER BY ID FETCH FIRST 5 ROWS ONLY')).toHaveLength(0);
	});

	it('createRownumWithOrderByRule flags ROWNUM with a trailing ORDER BY', () => {
		const rule = createRownumWithOrderByRule({
			id: 'T007',
			name: 'Rownum',
			description: 'desc',
			defaultSeverity: LintSeverity.Warning,
			statementEnd: qQuoteScanner,
		});
		expect(rule.check('SELECT * FROM T WHERE ROWNUM <= 5 ORDER BY ID')).toHaveLength(1);
		expect(rule.check('SELECT * FROM T WHERE ROWNUM <= 5 FETCH FIRST 5 ROWS ONLY')).toHaveLength(0);
		expect(rule.check('SELECT * FROM T WHERE ROWNUM <= 5')).toHaveLength(0);
	});
});
