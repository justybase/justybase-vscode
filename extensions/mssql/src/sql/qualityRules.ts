import {
	findPatternMatches,
	type LintIssue,
	type LintRule,
	LintSeverity,
} from '../../../../src/providers/linterRules';

function statementEnd(sql: string, start: number): number {
	let quote: "'" | '"' | undefined;
	let bracket = false;
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
		if (char === '[') {
			bracket = true;
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

/** Prefer an explicit projection over SELECT * in production T-SQL. */
export const ruleMSS001: LintRule = {
	id: 'MSS001',
	name: 'Select Star',
	description: 'Avoid SELECT * in production T-SQL when a stable projection is possible.',
	defaultSeverity: LintSeverity.Warning,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bSELECT\s+(?:TOP\s*\([^)]*\)\s+|TOP\s+\d+\s+)?\*/gi).map((match) =>
			issue(this, match.index + match[0].lastIndexOf('*'), match.index + match[0].lastIndexOf('*') + 1),
		);
	},
};

/** DELETE without WHERE removes every row. */
export const ruleMSS002: LintRule = {
	id: 'MSS002',
	name: 'Delete Without Where',
	description: 'DELETE without WHERE removes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\bDELETE\s+FROM\s+(?:\[[^\]]*\]|"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:\[[^\]]*\]|"[^"]+"|[A-Za-z_][\w$#]*)){0,2})/gi,
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
export const ruleMSS003: LintRule = {
	id: 'MSS003',
	name: 'Update Without Where',
	description: 'UPDATE without WHERE changes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\bUPDATE\s+(?:\[[^\]]*\]|"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:\[[^\]]*\]|"[^"]+"|[A-Za-z_][\w$#]*)){0,2})\s+SET\b/gi,
		)) {
			const end = statementEnd(sql, match.index);
			if (!containsKeyword(sql, match.index + match[0].length, end, /\bWHERE\b/i)) {
				issues.push(issue(this, match.index, match.index + 6));
			}
		}
		return issues;
	},
};

/** Netezza-only GROOM is not valid T-SQL. */
export const ruleMSS004: LintRule = {
	id: 'MSS004',
	name: 'Netezza Groom',
	description: 'GROOM is Netezza-only; use ALTER INDEX / maintenance plans on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bGROOM\b/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** Netezza DISTRIBUTE ON is not valid MSSQL DDL. */
export const ruleMSS005: LintRule = {
	id: 'MSS005',
	name: 'Netezza Distribute On',
	description: 'DISTRIBUTE ON is Netezza-only; use partitioned tables / indexes on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bDISTRIBUTE\s+ON\b/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** TOP / OFFSET FETCH without ORDER BY yields non-deterministic top-N. */
export const ruleMSS006: LintRule = {
	id: 'MSS006',
	name: 'Top-N Without Order By',
	description:
		'TOP / OFFSET FETCH without ORDER BY in the same SELECT can return non-deterministic rows; add ORDER BY for stable top-N.',
	defaultSeverity: LintSeverity.Warning,
	check(sql): LintIssue[] {
		const issues: LintIssue[] = [];
		for (const match of findPatternMatches(
			sql,
			/\b(?:TOP\s*\(|TOP\s+\d+|OFFSET\s+\d+)/gi,
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

/** Netezza LIMIT is not valid T-SQL — use TOP or OFFSET/FETCH. */
export const ruleMSS007: LintRule = {
	id: 'MSS007',
	name: 'Netezza Limit',
	description: 'LIMIT is Netezza-only; use TOP or OFFSET/FETCH NEXT on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\bLIMIT\s+\d+/gi).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

/** Netezza DB..TABLE notation is not valid on SQL Server. */
export const ruleMSS008: LintRule = {
	id: 'MSS008',
	name: 'Netezza Double-Dot Table',
	description: 'DB..TABLE is Netezza-only; use SCHEMA.TABLE or database.schema.table on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	check(sql): LintIssue[] {
		return findPatternMatches(sql, /\b[A-Za-z_][\w$#]*\s*\.\s*\.\s*[A-Za-z_][\w$#]*/g).map((match) =>
			issue(this, match.index, match.index + match[0].length),
		);
	},
};

export const mssqlSqlQualityRules: readonly LintRule[] = [
	ruleMSS001,
	ruleMSS002,
	ruleMSS003,
	ruleMSS004,
	ruleMSS005,
	ruleMSS006,
	ruleMSS007,
	ruleMSS008,
];
