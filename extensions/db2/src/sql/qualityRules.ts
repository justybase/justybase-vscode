import {
	findPatternMatches,
	type LintIssue,
	type LintRule,
	LintSeverity,
} from '../../../../src/providers/linterRules';

function statementEnd(sql: string, start: number): number {
	let quote: "'" | '"' | undefined;
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
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === ';') {
			return index;
		}
	}

	return sql.length;
}

function containsKeyword(sql: string, start: number, end: number, keyword: RegExp): boolean {
	return keyword.test(sql.slice(start, end));
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

/** Prefer an explicit projection over SELECT * in production Db2 SQL. */
export const ruleDB2001: LintRule = {
	id: 'DB2001',
	name: 'Select Star',
	description: 'Avoid SELECT * in production Db2 queries when a stable projection is possible.',
	defaultSeverity: LintSeverity.Warning,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bSELECT\s+\*/gi).map((match) =>
			issue(this, match.index + match[0].lastIndexOf('*'), match.index + match[0].lastIndexOf('*') + 1),
		);
	},
};

/** DELETE without WHERE removes every row. */
export const ruleDB2002: LintRule = {
	id: 'DB2002',
	name: 'Delete Without Where',
	description: 'DELETE without WHERE removes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\bDELETE\s+FROM\s+(?:"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*)){0,2})/gi,
		)) {
			const end = statementEnd(sql, match.index);
			if (!containsKeyword(sql, match.index + match[0].length, end, /\bWHERE\b/i)) {
				issues.push(issue(this, match.index, match.index + 6));
			}
		}
		return issues;
	},
};

/** UPDATE without WHERE updates every row. */
export const ruleDB2003: LintRule = {
	id: 'DB2003',
	name: 'Update Without Where',
	description: 'UPDATE without WHERE changes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\bUPDATE\s+(?:"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*)){0,2})\s+SET\b/gi,
		)) {
			const end = statementEnd(sql, match.index);
			if (!containsKeyword(sql, match.index + match[0].length, end, /\bWHERE\b/i)) {
				issues.push(issue(this, match.index, match.index + 6));
			}
		}
		return issues;
	},
};

/** Netezza-only GROOM is not valid Db2 SQL. */
export const ruleDB2004: LintRule = {
	id: 'DB2004',
	name: 'Netezza Groom',
	description: 'GROOM is Netezza-only; use RUNSTATS / REORG on Db2 LUW instead.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bGROOM\b/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** Netezza DISTRIBUTE ON is not valid Db2 table DDL. */
export const ruleDB2005: LintRule = {
	id: 'DB2005',
	name: 'Netezza Distribute On',
	description: 'DISTRIBUTE ON is Netezza-only; use DISTRIBUTE BY HASH / ORGANIZE BY on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bDISTRIBUTE\s+ON\b/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** FETCH FIRST / OPTIMIZE FOR without ORDER BY yields non-deterministic top-N. */
export const ruleDB2006: LintRule = {
	id: 'DB2006',
	name: 'Top-N Without Order By',
	description:
		'FETCH FIRST / OPTIMIZE FOR without ORDER BY in the same SELECT can return non-deterministic rows; add ORDER BY for stable top-N.',
	defaultSeverity: LintSeverity.Warning,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\b(?:FETCH\s+(?:FIRST|NEXT)|OPTIMIZE\s+FOR)\b/gi,
		)) {
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

/** Netezza LIMIT is not valid Db2 SQL — use FETCH FIRST. */
export const ruleDB2007: LintRule = {
	id: 'DB2007',
	name: 'Netezza Limit',
	description: 'LIMIT is Netezza-only; use FETCH FIRST n ROWS ONLY on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bLIMIT\s+\d+/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** Netezza DB..TABLE notation is not valid on Db2 LUW. */
export const ruleDB2008: LintRule = {
	id: 'DB2008',
	name: 'Netezza Double-Dot Table',
	description: 'DB..TABLE is Netezza-only; use SCHEMA.TABLE or CURRENT SCHEMA on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\b[A-Za-z_][\w$#]*\s*\.\s*\.\s*[A-Za-z_][\w$#]*/g).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

export const db2SqlQualityRules: readonly LintRule[] = [
	ruleDB2001,
	ruleDB2002,
	ruleDB2003,
	ruleDB2004,
	ruleDB2005,
	ruleDB2006,
	ruleDB2007,
	ruleDB2008,
];
