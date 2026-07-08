/**
 * SQL Linter Rules for Netezza
 * 
 * Modular, configurable lint rules for SQL analysis.
 * Each rule is a pure function that can be tested independently.
 */

import { hasMatchingSqlCaseEnd } from "../sqlParser/caseExpressionUtils";
import {
    isOffsetInSingleQuotedString,
    isOffsetInSqlComment,
} from "../sql/sqlSourceScan";
import {
    findFirstKeywordInRange,
    findPatternMatches,
    findPatternMatchesInRange,
    hasKeywordInRange,
    indexOfStatementSemicolon,
    indexOfWhereClauseEnd,
    isInsideStringOrComment,
    splitSqlStatementsWithOffsets,
} from "./sqlCommentScanUtils";

export {
    findPatternMatches,
    isInsideStringOrComment,
} from "./sqlCommentScanUtils";

export const LintSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
} as const;

export type LintSeverity = (typeof LintSeverity)[keyof typeof LintSeverity];

/**
 * Represents a lint issue found in SQL code
 */
export interface LintIssue {
    ruleId: string;
    message: string;
    severity: LintSeverity;
    startOffset: number;
    endOffset: number;
    suggestedFix?: string;
}

/**
 * Lint rule definition
 */
export interface LintRule {
    id: string;
    name: string;
    description: string;
    defaultSeverity: LintSeverity;
    /** If true, this rule only runs when explicitly triggered (not during automatic linting) */
    onDemandOnly?: boolean;
    check(sql: string): LintIssue[];
}

/**
 * Rule severity configuration from user settings
 */
export type RuleSeverityConfig = 'error' | 'warning' | 'information' | 'hint' | 'off';

/**
 * Convert string severity to VS Code DiagnosticSeverity
 */
export function parseSeverity(severity: RuleSeverityConfig): LintSeverity | null {
    switch (severity) {
        case 'error': return LintSeverity.Error;
        case 'warning': return LintSeverity.Warning;
        case 'information': return LintSeverity.Information;
        case 'hint': return LintSeverity.Hint;
        case 'off': return null;
        default: return LintSeverity.Warning;
    }
}

function isTopLevelSelectStatement(
    sql: string,
    start: number,
    end: number,
): boolean {
    const segment = sql.substring(start, end);
    const leadingWhitespace = segment.length - segment.trimStart().length;
    const contentStart = start + leadingWhitespace;
    const trimmed = sql.substring(contentStart, end);

    if (/^SELECT\b/i.test(trimmed)) {
        return true;
    }

    if (/^WITH\b/i.test(trimmed)) {
        return /\)\s*SELECT\b/i.test(trimmed);
    }

    return false;
}

// ============================================================================
// LINT RULES
// ============================================================================

/**
 * NZ001: SELECT * usage
 */
export const ruleNZ001: LintRule = {
    id: 'NZ001',
    name: 'Select Star',
    description: 'Avoid using SELECT * - specify explicit column names for better performance and maintainability',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bSELECT\s+\*/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            // Find the position of * within the match
            const starPos = match[0].indexOf('*');
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index + starPos,
                endOffset: match.index + starPos + 1
            });
        }

        return issues;
    }
};

/**
 * NZ002: DELETE without WHERE
 */
export const ruleNZ002: LintRule = {
    id: 'NZ002',
    name: 'Delete Without Where',
    description: 'DELETE statement without WHERE clause will delete all rows',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Match DELETE FROM ... but check if WHERE follows before the next statement or end
        const pattern = /\bDELETE\s+FROM\s+[\w."]+/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            const afterStart = match.index + match[0].length;
            const stmtEnd = indexOfStatementSemicolon(sql, match.index);

            if (!hasKeywordInRange(sql, afterStart, stmtEnd, /\bWHERE\b/i)) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: match.index,
                    endOffset: match.index + 6 // Just highlight "DELETE"
                });
            }
        }

        return issues;
    }
};

/**
 * NZ003: UPDATE without WHERE
 */
export const ruleNZ003: LintRule = {
    id: 'NZ003',
    name: 'Update Without Where',
    description: 'UPDATE statement without WHERE clause will update all rows',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bUPDATE\s+[\w."]+\s+SET\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            const afterStart = match.index + match[0].length;
            const stmtEnd = indexOfStatementSemicolon(sql, match.index);

            if (!hasKeywordInRange(sql, afterStart, stmtEnd, /\bWHERE\b/i)) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: match.index,
                    endOffset: match.index + 6 // Just highlight "UPDATE"
                });
            }
        }

        return issues;
    }
};

/**
 * NZ004: CROSS JOIN detected
 */
export const ruleNZ004: LintRule = {
    id: 'NZ004',
    name: 'Cross Join',
    description: 'CROSS JOIN produces a Cartesian product - verify this is intentional',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bCROSS\s+JOIN\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }

        return issues;
    }
};

/**
 * NZ005: Leading wildcard in LIKE
 */
export const ruleNZ005: LintRule = {
    id: 'NZ005',
    name: 'Leading Wildcard Like',
    description: "LIKE pattern with leading wildcard ('%...') prevents Zone Map pruning",
    defaultSeverity: LintSeverity.Hint,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Match LIKE '%something' or LIKE '%'
        const pattern = /\bLIKE\s+'%/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }

        return issues;
    }
};

/**
 * NZ006: ORDER BY without LIMIT
 */
function findMatchingParen(sql: string, openParenOffset: number): number {
    let depth = 0;
    for (let i = openParenOffset; i < sql.length; i++) {
        if (isInsideStringOrComment(sql, i)) {
            continue;
        }

        const char = sql[i];
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    return -1;
}

function buildOverClauseRanges(sql: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const overMatches = findPatternMatches(sql, /\bOVER\s*\(/gi);

    for (const match of overMatches) {
        const openParenOffset = match.index + match[0].lastIndexOf('(');
        const closeParenOffset = findMatchingParen(sql, openParenOffset);
        if (closeParenOffset > openParenOffset) {
            ranges.push({ start: openParenOffset, end: closeParenOffset });
        }
    }

    return ranges;
}

function isInsideOverClause(
    offset: number,
    overClauseRanges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
    return overClauseRanges.some((range) => offset > range.start && offset < range.end);
}

export const ruleNZ006: LintRule = {
    id: 'NZ006',
    name: 'Order By Without Limit',
    description: 'ORDER BY without LIMIT/FETCH may cause performance issues on large datasets',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bORDER\s+BY\b/gi;
        const matches = findPatternMatches(sql, pattern);
        const overClauseRanges = buildOverClauseRanges(sql);

        for (const match of matches) {
            if (isInsideOverClause(match.index, overClauseRanges)) {
                continue;
            }

            const afterStart = match.index + match[0].length;
            const stmtEnd = indexOfStatementSemicolon(sql, match.index);

            if (
                !hasKeywordInRange(
                    sql,
                    afterStart,
                    stmtEnd,
                    /\b(LIMIT|FETCH|TOP)\b/i,
                ) &&
                !hasKeywordInRange(sql, 0, match.index, /\bTOP\s+\d+\b/i)
            ) {
                    issues.push({
                        ruleId: this.id,
                        message: `${this.id}: ${this.description}`,
                        severity: this.defaultSeverity,
                        startOffset: match.index,
                        endOffset: match.index + match[0].length
                    });
            }
        }

        return issues;
    }
};

/**
 * NZ007: Inconsistent keyword casing
 */
export const ruleNZ007: LintRule = {
    id: 'NZ007',
    name: 'Inconsistent Keyword Case',
    description: 'SQL keywords have inconsistent casing - consider using consistent UPPER or lower case',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
            'ON', 'AND', 'OR', 'INSERT', 'INTO', 'UPDATE', 'DELETE', 'CREATE',
            'DROP', 'ALTER', 'TABLE', 'VIEW', 'INDEX', 'ORDER', 'BY', 'GROUP',
            'HAVING', 'UNION', 'ALL', 'DISTINCT', 'AS', 'SET', 'VALUES', 'NULL',
            'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'EXISTS', 'CASE', 'WHEN',
            'THEN', 'ELSE', 'END', 'LIMIT', 'OFFSET'];

        let upperCount = 0;
        let lowerCount = 0;
        const foundKeywords: { keyword: string; index: number; type: 'UPPER' | 'lower' | 'Mixed' }[] = [];

        // Helper to avoid double counting if patterns overlap (though keywords usually don't)
        // Set of start indices processed
        const processedIndices = new Set<number>();

        for (const keyword of keywords) {
            // Use case-insensitive global match
            const pattern = new RegExp(`\\b${keyword}\\b`, 'gi');
            const matches = findPatternMatches(sql, pattern);

            for (const match of matches) {
                // Ensure we don't process same location twice (unlikely with this keyword list but good for safety)
                if (processedIndices.has(match.index)) continue;
                processedIndices.add(match.index);

                const text = match[0];
                let type: 'UPPER' | 'lower' | 'Mixed';

                if (text === text.toUpperCase()) {
                    upperCount++;
                    type = 'UPPER';
                } else if (text === text.toLowerCase()) {
                    lowerCount++;
                    type = 'lower';
                } else {
                    type = 'Mixed';
                }

                foundKeywords.push({ keyword: text, index: match.index, type });
            }
        }

        // Determine dominant style
        // If count is equal, prefer UPPER as it's standard SQL convention
        const dominantIsUpper = upperCount >= lowerCount;
        const targetType = dominantIsUpper ? 'UPPER' : 'lower';

        // Check consistency
        for (const item of foundKeywords) {
            if (item.type === 'Mixed') {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Keyword '${item.keyword}' has mixed casing (expected ${dominantIsUpper ? 'UPPERCASE' : 'lowercase'})`,
                    severity: this.defaultSeverity,
                    startOffset: item.index,
                    endOffset: item.index + item.keyword.length
                });
            } else if (item.type !== targetType) {
                // Only report if it deviates from the dominant style derived from non-mixed keywords
                // If we have 0 upper and 0 lower (only mixed), we default to UPPER, so mixed will be reported above
                // If we have legitimate different casing, report it here
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Keyword '${item.keyword}' should be ${dominantIsUpper ? 'UPPERCASE' : 'lowercase'}`,
                    severity: this.defaultSeverity,
                    startOffset: item.index,
                    endOffset: item.index + item.keyword.length
                });
            }
        }

        return issues;
    }
};

/**
 * NZ008: TRUNCATE statement
 */
export const ruleNZ008: LintRule = {
    id: 'NZ008',
    name: 'Truncate Table',
    description: 'TRUNCATE removes all data and cannot be rolled back - use with caution',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bTRUNCATE\s+(TABLE\s+)?[\w."]+/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + 8 // Just highlight "TRUNCATE"
            });
        }

        return issues;
    }
};

/**
 * NZ009: OR in WHERE clause
 */
export const ruleNZ009: LintRule = {
    id: 'NZ009',
    name: 'Or In Where Clause',
    description: 'Multiple OR conditions may prevent Zone Map pruning - consider UNION for better performance',
    defaultSeverity: LintSeverity.Hint,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Look for WHERE ... OR patterns
        const wherePattern = /\bWHERE\b/gi;
        const whereMatches = findPatternMatches(sql, wherePattern);

        for (const whereMatch of whereMatches) {
            const searchStart = whereMatch.index + whereMatch[0].length;
            const stmtEnd = indexOfStatementSemicolon(sql, whereMatch.index);
            const nextClauseMatch = findFirstKeywordInRange(
                sql,
                searchStart,
                stmtEnd,
                /\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION)\b/i,
            );
            const whereEnd = nextClauseMatch
                ? searchStart + nextClauseMatch.index
                : stmtEnd;
            const orMatches = findPatternMatchesInRange(
                sql,
                whereMatch.index,
                whereEnd,
                /\bOR\b/gi,
            );

            if (orMatches.length >= 2) {
                const firstOr = orMatches[0];
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description} (${orMatches.length} OR conditions found)`,
                    severity: this.defaultSeverity,
                    startOffset: whereMatch.index + firstOr.index,
                    endOffset: whereMatch.index + firstOr.index + 2
                });
            }
        }

        return issues;
    }
};

/**
 * NZ010: Missing table alias in JOIN
 */
export const ruleNZ010: LintRule = {
    id: 'NZ010',
    name: 'Missing Table Alias',
    description: 'Consider using table aliases in JOINs for better readability',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Look for JOIN table_name followed directly by ON (no alias)
        const pattern = /\bJOIN\s+([\w."]+)\s+ON\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Table '${match[1]}' in JOIN has no alias - ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }

        return issues;
    }
};

/**
 * NZ011: CTAS missing DISTRIBUTE ON
 */
export const ruleNZ011: LintRule = {
    id: 'NZ011',
    name: 'CTAS Missing Distribution',
    description: 'CREATE TABLE AS SELECT should specify explicit data distribution',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Match CREATE TABLE [IF NOT EXISTS] table_name AS [ ( ] SELECT
        // pattern covers:
        // CREATE TABLE t AS SELECT
        // CREATE TABLE t AS (SELECT
        // CREATE TABLE IF NOT EXISTS t AS SELECT
        const pattern = /\bCREATE\s+TABLE\s+(?:(?:IF\s+NOT\s+EXISTS\s+)?[\w."]+\s+)?AS\s+(?:\(\s*)?SELECT\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            const endIndex = indexOfStatementSemicolon(sql, match.index);
            const statementContent = sql.substring(match.index, endIndex);

            // Check for DISTRIBUTE ON in this statement
            // We reuse findPatternMatches on the substring to safely ignore comments inside
            // But findPatternMatches expects global position or strict string. 
            // Let's just Regex test the substring, false negatives in comments are rare for keywords
            // but for correctness let's verify match isn't in comment.

            const distributePattern = /\bDISTRIBUTE\s+ON\b/i;
            const distMatch = distributePattern.exec(statementContent);

            let hasDistribute = false;
            if (distMatch) {
                // Verify the match isn't inside a comment relative to the original SQL
                if (!isInsideStringOrComment(sql, match.index + distMatch.index)) {
                    hasDistribute = true;
                }
            }

            if (!hasDistribute) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description} - Add 'DISTRIBUTE ON (...)' or 'DISTRIBUTE ON RANDOM'`,
                    severity: this.defaultSeverity,
                    startOffset: match.index,
                    endOffset: match.index + match[0].length
                });
            }
        }
        return issues;
    }
};

/**
 * NZ012: UPDATE with disallowed AS alias
 */
export const ruleNZ012: LintRule = {
    id: 'NZ012',
    name: 'Update Alias With AS',
    description: 'Netezza UPDATE statements do not support "AS" for table aliases. Use "UPDATE table alias" instead.',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bUPDATE\s+[\w."]+\s+AS\s+[\w."]+/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            const asMatch = /\bAS\b/i.exec(match[0]);
            if (asMatch) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: match.index + asMatch.index,
                    endOffset: match.index + asMatch.index + asMatch[0].length
                });
            }
        }
        return issues;
    }
};

/**
 * NZ013: Prefer UNION ALL over UNION
 */
export const ruleNZ013: LintRule = {
    id: 'NZ013',
    name: 'Prefer Union All',
    description: 'UNION performs a distinct operation which is slower than UNION ALL. Use UNION ALL if duplicates are not an issue.',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bUNION\b(?!\s+ALL\b)/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }
        return issues;
    }
};

/**
 * NZ014: OR in JOIN condition
 */
export const ruleNZ014: LintRule = {
    id: 'NZ014',
    name: 'Or In Join Condition',
    description: 'OR in JOIN condition can cause Cartesian product and severe performance degradation',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bJOIN\s+[\w.]+(?:\s+(?:AS\s+)?[\w]+)?\s+ON\b(?:(?!\bWHERE\b|\bJOIN\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b).)*?\bOR\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            // Find the OR position within the match using regex to respect word boundaries
            // Use case-insensitive flag for case insensitivity
            const orMatch = /\bOR\b/i.exec(match[0]);
            if (orMatch) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: match.index + orMatch.index,
                    endOffset: match.index + orMatch.index + orMatch[0].length
                });
            }
        }

        return issues;
    }
};

/**
 * NZ018: Self-referential join/WHERE condition
 */
export const ruleNZ018: LintRule = {
    id: 'NZ018',
    name: 'Self Referential Join',
    description: 'JOIN/WHERE condition compares the same column to itself - this is redundant and may cause performance issues',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\b(?:ON|WHERE|AND|OR)\b[^=!<>]*?\b([\w.]+)\s*=\s*\b\1\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            if (isIgnorableWhereOneEqualsOne(match)) {
                continue;
            }

            // Find the position of the first occurrence of the repeated identifier
            const identifierStart = match[0].indexOf(match[1]);
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description} (found '${match[1]}')`,
                severity: this.defaultSeverity,
                startOffset: match.index + identifierStart,
                endOffset: match.index + identifierStart + match[1].length
            });
        }

        return issues;
    }
};

/** Dynamic-SQL placeholder: `WHERE 1 = 1` before appending `AND …` predicates. */
function isIgnorableWhereOneEqualsOne(match: RegExpExecArray): boolean {
    if (!/^\s*WHERE\b/i.test(match[0])) {
        return false;
    }
    return match[1] === '1';
}

/**
 * NZ015: Functions in WHERE clause
 */
export const ruleNZ015: LintRule = {
    id: 'NZ015',
    name: 'Function in Where Clause',
    description: 'Using functions in WHERE clauses prevents Zone Map pruning. Use range comparisons where possible.',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // Inspect each WHERE clause and detect function(column) patterns.
        const wherePattern = /\bWHERE\b/gi;
        const whereMatches = findPatternMatches(sql, wherePattern);

        for (const whereMatch of whereMatches) {
            const searchStart = whereMatch.index + whereMatch[0].length;
            const stmtEnd = indexOfStatementSemicolon(sql, whereMatch.index);
            const whereEnd = indexOfWhereClauseEnd(sql, searchStart, stmtEnd);
            const functionPattern =
                /\b([A-Z_][A-Z0-9_]*)\s*\(\s*([A-Z_][A-Z0-9_]*(?:\.[A-Z_][A-Z0-9_]*)?)\s*(?:,|\))/gi;
            const functionMatches = findPatternMatchesInRange(
                sql,
                searchStart,
                whereEnd,
                functionPattern,
            );

            for (const functionMatch of functionMatches) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: searchStart + functionMatch.index,
                    endOffset:
                        searchStart +
                        functionMatch.index +
                        functionMatch[0].length,
                });
            }
        }

        return issues;
    }
};

/**
 * NZ016: Implicit Casting in Join
 */
export const ruleNZ016: LintRule = {
    id: 'NZ016',
    name: 'Implicit Casting in Join',
    description: 'Avoid joining columns with different data types to prevent performance degradation due to broadcasting/redistribution.',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        // This is a heuristic: look for joins where one side is wrapped in a cast or literal with different type
        // e.g. a.id = b.id_str::int or a.id = '123'
        const pattern = /\bJOIN\s+[\w."]+\s+ON\s+[\w."\s=]+'[^']*'/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }
        return issues;
    }
};

/**
 * NZ017: Double Quoted Identifiers
 */
export const ruleNZ017: LintRule = {
    id: 'NZ017',
    name: 'Double Quoted Identifiers',
    description: 'Using double quotes for identifiers makes them case-sensitive, which can lead to "Object not found" errors in Netezza.',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const regex = /"[\w ]+"/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(sql)) !== null) {
            if (
                !isOffsetInSqlComment(sql, match.index) &&
                !isOffsetInSingleQuotedString(sql, match.index)
            ) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: match.index,
                    endOffset: match.index + match[0].length
                });
            }
        }
        return issues;
    }
};

/**
 * NZ019: CASE expression without END
 */
export const ruleNZ019: LintRule = {
    id: 'NZ019',
    name: 'Case Without End',
    description: 'CASE expression must end with END keyword',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const caseStarts = findPatternMatches(sql, /\bCASE\b/gi);

        for (const caseStart of caseStarts) {
            if (!hasMatchingSqlCaseEnd(sql, caseStart.index)) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: caseStart.index,
                    endOffset: caseStart.index + caseStart[0].length,
                });
            }
        }

        return issues;
    }
};

/**
 * NZ020: Subquery Efficiency
 */
export const ruleNZ020: LintRule = {
    id: 'NZ020',
    name: 'Subquery Efficiency',
    description: 'Consider using EXISTS or INNER JOIN instead of IN (SELECT ...) for better performance on large datasets.',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /\bIN\s*\(\s*SELECT\b/gi;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description}`,
                severity: this.defaultSeverity,
                startOffset: match.index,
                endOffset: match.index + match[0].length
            });
        }
        return issues;
    }
};

/**
 * NZ021: Double comma
 */
export const ruleNZ021: LintRule = {
    id: 'NZ021',
    name: 'Double Comma',
    description: 'Consecutive commas (,,) indicate a missing expression or an extra comma',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const pattern = /,,/g;
        const matches = findPatternMatches(sql, pattern);

        for (const match of matches) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${this.description} - Remove the extra comma`,
                severity: this.defaultSeverity,
                startOffset: match.index + 1,
                endOffset: match.index + 2
            });
        }

        return issues;
    }
};

/**
 * NZ022: WHERE without FROM
 */
export const ruleNZ022: LintRule = {
    id: 'NZ022',
    name: 'Where Without From',
    description: 'WHERE clause used without FROM clause - SELECT statements with WHERE require a FROM clause',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];

        for (const statement of splitSqlStatementsWithOffsets(sql)) {
            const stmtStart = statement.startOffset;
            const stmtEnd = statement.endOffset;

            if (!isTopLevelSelectStatement(sql, stmtStart, stmtEnd)) {
                continue;
            }

            const selectMatch = findFirstKeywordInRange(
                sql,
                stmtStart,
                stmtEnd,
                /\bSELECT\b/i,
            );
            if (!selectMatch) {
                continue;
            }

            const selectOffset = stmtStart + selectMatch.index;
            const afterSelectStart = selectOffset + selectMatch[0].length;
            const whereMatch = findFirstKeywordInRange(
                sql,
                afterSelectStart,
                stmtEnd,
                /\bWHERE\b/i,
            );
            if (!whereMatch) {
                continue;
            }

            const whereOffset = afterSelectStart + whereMatch.index;
            if (
                !hasKeywordInRange(
                    sql,
                    afterSelectStart,
                    whereOffset,
                    /\bFROM\b/i,
                )
            ) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${this.description}`,
                    severity: this.defaultSeverity,
                    startOffset: whereOffset,
                    endOffset: whereOffset + whereMatch[0].length,
                });
            }
        }

        return issues;
    }
};

/**
 * All available lint rules
 */
export const allRules: LintRule[] = [
    ruleNZ001,
    ruleNZ002,
    ruleNZ003,
    ruleNZ004,
    ruleNZ005,
    ruleNZ006,
    ruleNZ007,
    ruleNZ008,
    ruleNZ009,
    ruleNZ010,
    ruleNZ011,
    ruleNZ012,
    ruleNZ013,
    ruleNZ014,
    ruleNZ015,
    ruleNZ016,
    ruleNZ017,
    ruleNZ018,
    ruleNZ019,
    ruleNZ020,
    ruleNZ021,
    ruleNZ022
];

/**
 * Get a rule by its ID
 */
export function getRuleById(id: string): LintRule | undefined {
    return allRules.find(rule => rule.id === id);
}

