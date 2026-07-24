import {
    findPatternMatches,
    type LintIssue,
    type LintRule,
    LintSeverity,
} from '../../../../src/providers/linterRules';

function statementEnd(sql: string, start: number): number {
    let quote: "'" | '"' | undefined;
    let qQuoteDelim: string | undefined;
    let lineComment = false;
    let blockComment = false;

    const isOpeningBracket = (c: string): boolean => c === '[' || c === '{' || c === '<' || c === '(';
    const matchingBracket = (c: string): string => {
        if (c === '[') return ']';
        if (c === '{') return '}';
        if (c === '<') return '>';
        if (c === '(') return ')';
        return c;
    };

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
        if (char === 'q' && next === '\'') {
            const delimStart = index + 2;
            if (delimStart < sql.length) {
                const delimChar = sql[delimStart];
                qQuoteDelim = delimChar;
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

export const ruleORA001: LintRule = {
    id: 'ORA001',
    name: 'Select Star',
    description: 'Avoid SELECT * in production Oracle queries when a stable projection is possible.',
    defaultSeverity: LintSeverity.Warning,
    check(sql): LintIssue[] {
        return findPatternMatches(sql, /\bSELECT\s+\*/gi).map((match) =>
            issue(this, match.index + match[0].lastIndexOf('*'), match.index + match[0].lastIndexOf('*') + 1),
        );
    },
};

export const ruleORA002: LintRule = {
    id: 'ORA002',
    name: 'Delete Without Where',
    description: 'DELETE without WHERE removes every row in the target table.',
    defaultSeverity: LintSeverity.Error,
    check(sql): LintIssue[] {
        const issues: LintIssue[] = [];
        for (const match of findPatternMatches(sql, /\bDELETE\s+FROM\s+(?:"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*)){0,2})/gi)) {
            const end = statementEnd(sql, match.index);
            if (!containsKeyword(sql, match.index + match[0].length, end, /\bWHERE\b/i)) {
                issues.push(issue(this, match.index, match.index + 6));
            }
        }
        return issues;
    },
};

export const ruleORA003: LintRule = {
    id: 'ORA003',
    name: 'Update Without Where',
    description: 'UPDATE without WHERE changes every row in the target table.',
    defaultSeverity: LintSeverity.Error,
    check(sql): LintIssue[] {
        const issues: LintIssue[] = [];
        for (const match of findPatternMatches(sql, /\bUPDATE\s+(?:"[^"]+"|[A-Za-z_][\w$#]*(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*)){0,2})\s+SET\b/gi)) {
            const end = statementEnd(sql, match.index);
            if (!containsKeyword(sql, match.index + match[0].length, end, /\bWHERE\b/i)) {
                issues.push(issue(this, match.index, match.index + 6));
            }
        }
        return issues;
    },
};

export const ruleORA004: LintRule = {
    id: 'ORA004',
    name: 'Rownum With Order By',
    description: 'ROWNUM is evaluated before a same-level ORDER BY; use an ordered subquery or FETCH FIRST for deterministic top-N results.',
    defaultSeverity: LintSeverity.Warning,
    check(sql): LintIssue[] {
        const issues: LintIssue[] = [];
        for (const match of findPatternMatches(sql, /\bROWNUM\b/gi)) {
            const end = statementEnd(sql, match.index);
            const afterRownum = sql.slice(match.index + match[0].length, end);
            if (/\bORDER\s+BY\b/i.test(afterRownum) && !/\bFETCH\s+(?:FIRST|NEXT)\b/i.test(afterRownum)) {
                issues.push(issue(this, match.index, match.index + match[0].length));
            }
        }
        return issues;
    },
};

export const oracleSqlQualityRules: readonly LintRule[] = [
    ruleORA001,
    ruleORA002,
    ruleORA003,
    ruleORA004,
];
