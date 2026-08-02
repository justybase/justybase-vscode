/**
 * Shared factory for dialect quality rules (DB2 / MSSQL / Oracle).
 *
 * The rule *logic* (statement-end scanning, SELECT *, DELETE/UPDATE without
 * WHERE, Netezza-only constructs, top-N without ORDER BY) lives here once;
 * each dialect supplies its own ids, texts, severities and dialect-specific
 * patterns (bracketed identifiers, q-quotes, TOP variants).
 */

import { findPatternMatches } from './linterRules';
import type { LintIssue, LintRule, LintSeverity } from './linterRules';

// ---------------------------------------------------------------------------
// Statement-end scanner
// ---------------------------------------------------------------------------

export interface StatementEndScannerOptions {
	/** Track MSSQL `[bracket]` identifiers (with `]]` escape). */
	brackets?: boolean;
	/** Track Oracle `q'...'` quoted literals. */
	oracleQQuote?: boolean;
}

export type StatementEndScanner = (sql: string, start: number) => number;

export function createStatementEndScanner(
	options: StatementEndScannerOptions = {},
): StatementEndScanner {
	const { brackets = false, oracleQQuote = false } = options;

	const isOpeningBracket = (c: string): boolean =>
		c === '[' || c === '{' || c === '<' || c === '(';
	const matchingBracket = (c: string): string => {
		if (c === '[') return ']';
		if (c === '{') return '}';
		if (c === '<') return '>';
		if (c === '(') return ')';
		return c;
	};

	return function statementEnd(sql: string, start: number): number {
		let quote: "'" | '"' | undefined;
		let bracket = false;
		let qQuoteDelim: string | undefined;
		let lineComment = false;
		let blockComment = false;

		for (let index = start; index < sql.length; index++) {
			const char = sql[index];
			const next = sql[index + 1];

			if (lineComment) {
				if (char === '\n' || char === '\r') {
					lineComment = false;
				}
				continue;
			}

			if (blockComment) {
				if (char === '*' && next === '/') {
					blockComment = false;
					index++;
				}
				continue;
			}

			if (bracket) {
				if (char === ']' && next === ']') {
					index++;
					continue;
				}
				if (char === ']') {
					bracket = false;
				}
				continue;
			}

			if (qQuoteDelim) {
				if (isOpeningBracket(qQuoteDelim[0])) {
					if (char === matchingBracket(qQuoteDelim[0]) && next === "'") {
						qQuoteDelim = undefined;
						index++;
					}
				} else if (char === qQuoteDelim[0] && next === "'") {
					qQuoteDelim = undefined;
					index++;
				}
				continue;
			}

			if (quote) {
				if (char === quote) {
					if (next === quote) {
						index++;
					} else {
						quote = undefined;
					}
				}
				continue;
			}

			if (char === '-' && next === '-') {
				lineComment = true;
				index++;
				continue;
			}
			if (char === '/' && next === '*') {
				blockComment = true;
				index++;
				continue;
			}
			if (brackets && char === '[') {
				bracket = true;
				continue;
			}
			if (oracleQQuote && char === 'q' && next === "'") {
				const delimStart = index + 2;
				if (delimStart < sql.length) {
					qQuoteDelim = sql[delimStart];
					index = delimStart;
					continue;
				}
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (char === ';') {
				return index;
			}
		}

		return sql.length;
	};
}

// ---------------------------------------------------------------------------
// Identifier / statement patterns
// ---------------------------------------------------------------------------

export interface IdentifierPatternOptions {
	/** Include the MSSQL `[bracket]` identifier alternative. */
	brackets?: boolean;
}

export function createIdentifierPattern(options: IdentifierPatternOptions = {}): string {
	const identifier: string = options.brackets
		? '\\[[^\\]]*\\]|"[^"]+"|[A-Za-z_][\\w$#]*'
		: '"[^"]+"|[A-Za-z_][\\w$#]*';
	return `(?:${identifier}(?:\\s*\\.\\s*(?:${identifier})){0,2})`;
}

export function createDeleteFromPattern(identifierPattern: string): RegExp {
	return new RegExp(`\\bDELETE\\s+FROM\\s+${identifierPattern}`, 'gi');
}

export function createUpdateSetPattern(identifierPattern: string): RegExp {
	return new RegExp(`\\bUPDATE\\s+${identifierPattern}\\s+SET\\b`, 'gi');
}

// ---------------------------------------------------------------------------
// Rule factories
// ---------------------------------------------------------------------------

export interface QualityRuleOptions {
	id: string;
	name: string;
	description: string;
	defaultSeverity: LintSeverity;
}

function issue(rule: LintRule, startOffset: number, endOffset: number): LintIssue {
	return {
		ruleId: rule.id,
		message: `${rule.id}: ${rule.description}`,
		severity: rule.defaultSeverity,
		startOffset,
		endOffset,
	};
}

export interface SelectStarRuleOptions extends QualityRuleOptions {
	/** Regex matching `SELECT ... *`; the `*` must be part of the match. */
	selectStarPattern: RegExp;
}

export function createSelectStarRule(options: SelectStarRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, selectStarPattern } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			return findPatternMatches(sql, selectStarPattern).map((match) =>
				issue(this, match.index + match[0].lastIndexOf('*'), match.index + match[0].lastIndexOf('*') + 1),
			);
		},
	};
}

export interface DeleteUpdateRuleOptions extends QualityRuleOptions {
	statementEnd: StatementEndScanner;
	/** Regex matching the `DELETE FROM <target>` / `UPDATE <target> SET` prefix. */
	targetPattern: RegExp;
}

export function createDeleteWithoutWhereRule(options: DeleteUpdateRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, statementEnd, targetPattern } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			const issues: LintIssue[] = [];
			for (const match of findPatternMatches(sql, targetPattern)) {
				const end = statementEnd(sql, match.index);
				if (!/\bWHERE\b/i.test(sql.slice(match.index + match[0].length, end))) {
					issues.push(issue(this, match.index, match.index + 6));
				}
			}
			return issues;
		},
	};
}

export function createUpdateWithoutWhereRule(options: DeleteUpdateRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, statementEnd, targetPattern } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			const issues: LintIssue[] = [];
			for (const match of findPatternMatches(sql, targetPattern)) {
				const end = statementEnd(sql, match.index);
				if (!/\bWHERE\b/i.test(sql.slice(match.index + match[0].length, end))) {
					issues.push(issue(this, match.index, match.index + 6));
				}
			}
			return issues;
		},
	};
}

export interface KeywordRuleOptions extends QualityRuleOptions {
	/** Regex matching the full offending construct (GROOM, DISTRIBUTE ON, LIMIT, ...). */
	keywordPattern: RegExp;
}

export function createKeywordRule(options: KeywordRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, keywordPattern } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			return findPatternMatches(sql, keywordPattern).map((match) =>
				issue(this, match.index, match.index + match[0].length),
			);
		},
	};
}

export function createDoubleDotTableRule(options: QualityRuleOptions): LintRule {
	return createKeywordRule({
		...options,
		keywordPattern: /\b[A-Za-z_][\w$#]*\s*\.\s*\.\s*[A-Za-z_][\w$#]*/g,
	});
}

export interface TopNWithoutOrderByRuleOptions extends QualityRuleOptions {
	statementEnd: StatementEndScanner;
	/** Regex matching the top-N construct (FETCH FIRST, OPTIMIZE FOR, TOP, OFFSET, ...). */
	topNPattern: RegExp;
}

export function createTopNWithoutOrderByRule(options: TopNWithoutOrderByRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, statementEnd, topNPattern } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			const issues: LintIssue[] = [];
			for (const match of findPatternMatches(sql, topNPattern)) {
				const start = sql.lastIndexOf(';', match.index - 1) + 1;
				const end = statementEnd(sql, match.index);
				const statement = sql.slice(start, end);
				if (!/\bORDER\s+BY\b/i.test(statement)) {
					issues.push(issue(this, match.index, match.index + match[0].length));
				}
			}
			return issues;
		},
	};
}

export interface RownumWithOrderByRuleOptions extends QualityRuleOptions {
	statementEnd: StatementEndScanner;
}

export function createRownumWithOrderByRule(options: RownumWithOrderByRuleOptions): LintRule {
	const { id, name, description, defaultSeverity, statementEnd } = options;
	return {
		id,
		name,
		description,
		defaultSeverity,
		check(sql): LintIssue[] {
			const issues: LintIssue[] = [];
			for (const match of findPatternMatches(sql, /\bROWNUM\b/gi)) {
				const end = statementEnd(sql, match.index);
				const afterRownum = sql.slice(match.index + match[0].length, end);
				if (
					/\bORDER\s+BY\b/i.test(afterRownum) &&
					!/\bFETCH\s+(?:FIRST|NEXT)\b/i.test(afterRownum)
				) {
					issues.push(issue(this, match.index, match.index + match[0].length));
				}
			}
			return issues;
		},
	};
}
