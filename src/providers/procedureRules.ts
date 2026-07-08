/**
 * Procedure-Specific Lint Rules for Netezza
 * 
 * Rules for analyzing stored procedures (NZPLSQL, etc.)
 * These rules are typically more complex and run on-demand.
 * 
 * FIXED VERSION - corrected false positives in:
 * - NZP006: LOOP detection (FOR/WHILE loops)
 * - NZP005: IF detection (nested IF blocks)
 * - NZP004: BEGIN/END detection (transactions)
 * - NZP017: CASE detection
 */

import { LintIssue, LintRule, LintSeverity, findPatternMatches } from './linterRules';
import {
    extractProcedureBody,
    hasMatchingSqlCaseEnd,
    isEmbeddedDmlSelect,
    PROCEDURAL_END_PATTERN,
    removeCommentsAndStrings,
    shouldSkipCstMigratedProcedureRule,
} from '../sqlParser/procedure/procedureAnalysis';
import {
    beginProcedureRuleEvaluation,
    endProcedureRuleEvaluation,
    warmProcedureParseGate,
} from '../sqlParser/procedure/procedureParseGate';

const PROCEDURE_ON_DEMAND_ONLY = true;

// ============================================================================
// RULE NZP001: Missing BEGIN_PROC/END_PROC
// ============================================================================
export const ruleNZP001: LintRule = {
    id: 'NZP001',
    name: 'Missing Procedure Delimiters',
    description: 'Stored procedure must have BEGIN_PROC and END_PROC delimiters',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const cleaned = removeCommentsAndStrings(sql);

        if (!/\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(cleaned)) {
            return issues;
        }

        const hasBeginProc = /\bBEGIN_PROC\b/i.test(cleaned);
        const hasEndProc = /\bEND_PROC\b/i.test(cleaned);

        if (!hasBeginProc) {
            const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
            if (createMatch) {
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Missing BEGIN_PROC delimiter`,
                    severity: this.defaultSeverity,
                    startOffset: createMatch.index,
                    endOffset: createMatch.index + createMatch[0].length
                });
            }
        }

        if (!hasEndProc) {
            const lastIndex = sql.length - 1;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Missing END_PROC delimiter`,
                severity: this.defaultSeverity,
                startOffset: Math.max(0, lastIndex - 10),
                endOffset: lastIndex
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP002: Missing LANGUAGE clause
// ============================================================================
export const ruleNZP002: LintRule = {
    id: 'NZP002',
    name: 'Missing Language Specification',
    description: 'Stored procedure must specify LANGUAGE (NZPLSQL, SQL, etc.)',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const cleaned = removeCommentsAndStrings(sql);

        const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
        if (!createMatch) return issues;

        if (!/\bLANGUAGE\s+(NZPLSQL|SQL|C|JAVA)\b/i.test(cleaned)) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Missing LANGUAGE clause (should be NZPLSQL, SQL, C, or JAVA)`,
                severity: this.defaultSeverity,
                startOffset: createMatch.index,
                endOffset: createMatch.index + createMatch[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP003: Missing RETURNS clause
// ============================================================================
export const ruleNZP003: LintRule = {
    id: 'NZP003',
    name: 'Missing Return Type',
    description: 'Stored procedure must specify RETURNS type',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const cleaned = removeCommentsAndStrings(sql);

        const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
        if (!createMatch) return issues;

        if (!/\bRETURNS\s+\w+/i.test(cleaned)) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Missing RETURNS clause`,
                severity: this.defaultSeverity,
                startOffset: createMatch.index,
                endOffset: createMatch.index + createMatch[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP004: Unmatched BEGIN/END blocks
// FIXED: Improved pattern to avoid false positives with BEGIN TRANSACTION
// ============================================================================
export const ruleNZP004: LintRule = {
    id: 'NZP004',
    name: 'Unmatched BEGIN/END Blocks',
    description: 'Every BEGIN must have a matching END',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP004')) return issues;
        const cleaned = removeCommentsAndStrings(sql);

        // Check if this is a procedure
        if (!/\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(cleaned)) {
            return issues;
        }

        const procBody = extractProcedureBody(cleaned);

        if (procBody) {
            // Count BEGIN (exclude BEGIN_PROC, BEGIN TRANSACTION, BEGIN WORK)
            const begins = findPatternMatches(procBody.body, /\bBEGIN\b(?!\s*(_PROC|TRANSACTION|WORK)\b)/gi);
            // Count END (exclude END_PROC, END IF, END LOOP, END CASE, END TRANSACTION, END WORK)
            // END can be followed by semicolon, whitespace, or END_PROC/END IF/etc.
            const ends = findPatternMatches(procBody.body, PROCEDURAL_END_PATTERN);

            if (begins.length !== ends.length) {
                const offset = procBody.startOffset;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Unmatched BEGIN/END blocks (${begins.length} BEGIN vs ${ends.length} END)`,
                    severity: this.defaultSeverity,
                    startOffset: offset,
                    endOffset: offset + 10
                });
            }
        } else {
            // Fallback: check the entire SQL if we can't extract procedure body
            const begins = findPatternMatches(cleaned, /\bBEGIN\b(?!\s*(_PROC|TRANSACTION|WORK)\b)/gi);
            const ends = findPatternMatches(cleaned, PROCEDURAL_END_PATTERN);

            if (begins.length !== ends.length) {
                const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
                if (createMatch) {
                    issues.push({
                        ruleId: this.id,
                        message: `${this.id}: Unmatched BEGIN/END blocks (${begins.length} BEGIN vs ${ends.length} END)`,
                        severity: this.defaultSeverity,
                        startOffset: createMatch.index,
                        endOffset: createMatch.index + createMatch[0].length
                    });
                }
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP005: IF without END IF
// FIXED: Improved pattern to avoid counting IF in ELSIF/END IF
// ============================================================================
export const ruleNZP005: LintRule = {
    id: 'NZP005',
    name: 'Unmatched IF Statement',
    description: 'IF statement must be closed with END IF',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP005')) return issues;
        const cleaned = removeCommentsAndStrings(sql);
        const procBody = extractProcedureBody(cleaned);

        if (!procBody) return issues;

        // FIXED: Better pattern - exclude ELSIF and END IF
        // Only count IF that starts a new conditional block
        const ifs = findPatternMatches(procBody.body, /(?<!ELS|END\s)\bIF\b(?!\s+(?:NOT\s+)?EXISTS\b)/gi);
        const endIfs = findPatternMatches(procBody.body, /\bEND\s+IF\b/gi);

        if (ifs.length !== endIfs.length) {
            // Only report once for the procedure, not for each IF
            const offset = procBody.startOffset;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Unmatched IF statements (${ifs.length} IF vs ${endIfs.length} END IF)`,
                severity: this.defaultSeverity,
                startOffset: offset,
                endOffset: offset + 10
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP006: LOOP without END LOOP
// FIXED: Major fix - properly count loop constructs
// FOR i IN 1..10 LOOP should count as 1 loop, not 2
// WHILE condition LOOP should count as 1 loop, not 2
// ============================================================================
export const ruleNZP006: LintRule = {
    id: 'NZP006',
    name: 'Unmatched LOOP Statement',
    description: 'LOOP statement must be closed with END LOOP',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP006')) return issues;
        const cleaned = removeCommentsAndStrings(sql);
        const procBody = extractProcedureBody(cleaned);

        if (!procBody) return issues;

        // Count all LOOP keywords (standalone, FOR...LOOP, WHILE...LOOP all end with LOOP)
        // Each END LOOP closes exactly one LOOP construct
        // Use negative lookbehind (?<!END\s) to exclude LOOP that is part of END LOOP
        const loopMatches = procBody.body.match(/(?<!END\s)LOOP\b/gi) || [];
        const endLoopMatches = procBody.body.match(/\bEND\s+LOOP\b/gi) || [];
        const totalLoops = loopMatches.length;
        const endLoops = endLoopMatches.length;

        if (totalLoops !== endLoops) {
            const offset = procBody.startOffset;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Unmatched LOOP statements (${totalLoops} LOOP constructs vs ${endLoops} END LOOP)`,
                severity: this.defaultSeverity,
                startOffset: offset,
                endOffset: offset + 10
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP007: Missing semicolon after statements
// ============================================================================
export const ruleNZP007: LintRule = {
    id: 'NZP007',
    name: 'Missing Semicolon',
    description: 'SQL statements should end with semicolon',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        // Check for common statements without semicolons
        const patterns = [
            /\b(SELECT|INSERT|UPDATE|DELETE|DECLARE)\s+[^;]+?(?=\n\s*\b(BEGIN|END|IF|LOOP|FOR|WHILE|DECLARE|SELECT|INSERT|UPDATE|DELETE|EXCEPTION)\b)/gi
        ];

        for (const pattern of patterns) {
            const matches = findPatternMatches(procBody.body, pattern);
            for (const match of matches) {
                const stmtType = match[1].toUpperCase();
                if (stmtType === 'INSERT' && /^INSERT\s+INTO\b/i.test(match[0])) {
                    const after = procBody.body.substring(
                        match.index + match[0].length,
                        match.index + match[0].length + 100
                    );
                    if (/^\s*SELECT\b/i.test(after)) {
                        continue;
                    }
                }
                if (stmtType === 'SELECT') {
                    if (/\bINTO\b/i.test(match[0])) {
                        continue;
                    }
                    if (/\(\s*$/.test(match[0].trimEnd())) {
                        continue;
                    }
                    if (isEmbeddedDmlSelect(procBody.body, match.index)) {
                        continue;
                    }
                }

                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Statement may be missing semicolon`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset + match[0].length - 1,
                    endOffset: absoluteOffset + match[0].length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP008: Variable declared but not used
// ============================================================================
export const ruleNZP008: LintRule = {
    id: 'NZP008',
    name: 'Unused Variable',
    description: 'Variable declared but never used',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP008')) return issues;
        const cleaned = removeCommentsAndStrings(sql);
        const procBody = extractProcedureBody(cleaned);

        if (!procBody) return issues;

        // Find DECLARE block
        const declareMatch = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(procBody.body);
        if (!declareMatch) return issues;
        const declareBlock = declareMatch[1];
        const bodyAfterDeclare = procBody.body.substring(declareMatch.index + declareMatch[0].length);

        // Extended data type pattern
        const varPattern = /\b([a-z_][a-z0-9_]*)\s+(INTEGER|VARCHAR|NUMERIC|RECORD|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|VARRAY|TABLE|CURSOR|ROWTYPE|DECIMAL|MONEY)\b/gi;
        const variables = findPatternMatches(declareBlock, varPattern);

        for (const varMatch of variables) {
            const varName = varMatch[1];
            // FIXED: Use word boundaries to avoid false positives
            const usagePattern = new RegExp(`\\b${varName}\\b`, 'gi');
            const usages = findPatternMatches(bodyAfterDeclare, usagePattern);

            if (usages.length === 0) {
                const absoluteOffset = procBody.startOffset + declareMatch.index + varMatch.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Variable '${varName}' is declared but never used`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + varName.length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP009: Missing EXCEPTION handler
// ============================================================================
export const ruleNZP009: LintRule = {
    id: 'NZP009',
    name: 'Missing Exception Handler',
    description: 'Procedure should have EXCEPTION handler for error handling',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const cleaned = removeCommentsAndStrings(sql);
        const procBody = extractProcedureBody(cleaned);

        if (!procBody) return issues;

        if (!/\bEXCEPTION\b/i.test(procBody.body)) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Consider adding EXCEPTION handler for better error handling`,
                severity: this.defaultSeverity,
                startOffset: procBody.startOffset,
                endOffset: procBody.startOffset + 10
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP010: RAISE without severity level
// ============================================================================
export const ruleNZP010: LintRule = {
    id: 'NZP010',
    name: 'RAISE Without Severity',
    description: 'RAISE should specify severity level (NOTICE, WARNING, ERROR, EXCEPTION)',
    defaultSeverity: LintSeverity.Information,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const raisePattern = /\bRAISE\b(?!\s+(NOTICE|WARNING|ERROR|EXCEPTION))/gi;
        const matches = findPatternMatches(procBody.body, raisePattern);

        for (const match of matches) {
            const absoluteOffset = procBody.startOffset + match.index;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: RAISE should specify severity level (NOTICE, WARNING, ERROR, or EXCEPTION)`,
                severity: this.defaultSeverity,
                startOffset: absoluteOffset,
                endOffset: absoluteOffset + match[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP011: Missing INTO clause in SELECT
// Regex fallback only — superseded by SQL037 when Chevrotain CST parse succeeds.
// ============================================================================
export const ruleNZP011: LintRule = {
    id: 'NZP011',
    name: 'Missing INTO in SELECT (regex fallback)',
    description: 'SELECT in procedure should have INTO clause to store results (use SQL037 when CST parse succeeds)',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP011')) return issues;
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        // Find SELECT statements
        const selectPattern = /\bSELECT\b[\s\S]*?(?=;)/gi;
        const matches = findPatternMatches(procBody.body, selectPattern);

        for (const match of matches) {
            const selectText = match[0];

            // Skip INSERT INTO ... SELECT, CTAS, or SELECT with INTO
            if (
                !/\bINTO\b/i.test(selectText) &&
                !/\bINSERT\s+INTO\b/i.test(selectText) &&
                !isEmbeddedDmlSelect(procBody.body, match.index)
            ) {
                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: SELECT statement should have INTO clause to store results in variables`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + 6
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP012: ELSIF instead of ELSEIF
// ============================================================================
export const ruleNZP012: LintRule = {
    id: 'NZP012',
    name: 'Incorrect ELSIF Syntax',
    description: 'Use ELSIF (not ELSEIF or ELSE IF) in NZPLSQL',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const wrongPattern = /\b(ELSEIF|ELSE\s+IF)\b/gi;
        const matches = findPatternMatches(procBody.body, wrongPattern);

        for (const match of matches) {
            const absoluteOffset = procBody.startOffset + match.index;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Use ELSIF instead of ${match[0]} in NZPLSQL`,
                severity: this.defaultSeverity,
                startOffset: absoluteOffset,
                endOffset: absoluteOffset + match[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP013: Missing THEN after IF/ELSIF
// ============================================================================
export const ruleNZP013: LintRule = {
    id: 'NZP013',
    name: 'Missing THEN Keyword',
    description: 'IF and ELSIF statements must have THEN keyword',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP013')) return issues;
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const ifStarts = findPatternMatches(
            procBody.body,
            /(?<!ELS|END\s)\b(IF|ELSIF)\b(?!\s+(?:NOT\s+)?EXISTS\b)/gi
        );

        for (const match of ifStarts) {
            const afterKeyword = procBody.body.substring(match.index + match[0].length);
            const terminator = afterKeyword.search(/\b(ELSIF|ELSE|END\s+IF)\b|;/i);
            const conditionBlock = terminator >= 0
                ? afterKeyword.substring(0, terminator)
                : afterKeyword;

            if (!/\bTHEN\b/i.test(conditionBlock)) {
                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: ${match[1].toUpperCase()} statement missing THEN keyword`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + match[0].length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP014: EXIT without WHEN in LOOP
// ============================================================================
export const ruleNZP014: LintRule = {
    id: 'NZP014',
    name: 'Unconditional EXIT',
    description: 'EXIT in loop should have WHEN condition to avoid infinite loops',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const exitPattern = /\bEXIT\b(?!\s+WHEN)/gi;
        const matches = findPatternMatches(procBody.body, exitPattern);

        for (const match of matches) {
            const absoluteOffset = procBody.startOffset + match.index;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Consider using EXIT WHEN instead of unconditional EXIT`,
                severity: this.defaultSeverity,
                startOffset: absoluteOffset,
                endOffset: absoluteOffset + match[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP015: Parameter naming convention
// ============================================================================
export const ruleNZP015: LintRule = {
    id: 'NZP015',
    name: 'Parameter Naming Convention',
    description: 'Parameters should use prefix (e.g., p_) to distinguish from columns',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];

        // Find procedure parameters
        const procPattern = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+\w+\s*\(([\s\S]*?)\)/i;
        const procMatch = procPattern.exec(sql);

        if (!procMatch) return issues;

        const params = procMatch[2];
        // Extended data type pattern
        const paramPattern = /\b([a-z_][a-z0-9_]*)\s+(IN\s+|OUT\s+|INOUT\s+)?(INTEGER|VARCHAR|NUMERIC|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|DECIMAL|MONEY)\b/gi;
        const matches = findPatternMatches(params, paramPattern);

        for (const match of matches) {
            const paramName = match[1];
            if (!/^(p_|in_|out_|inout_)/i.test(paramName)) {
                const absoluteOffset = procMatch.index + procMatch[0].indexOf(params) + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Parameter '${paramName}' should use prefix like p_, in_, out_, or inout_`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + paramName.length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP016: Variable naming convention
// ============================================================================
export const ruleNZP016: LintRule = {
    id: 'NZP016',
    name: 'Variable Naming Convention',
    description: 'Variables should use prefix (e.g., v_) to distinguish from columns',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const declareMatch = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(procBody.body);
        if (!declareMatch) return issues;

        // Extended data type pattern
        const varPattern = /\b([a-z_][a-z0-9_]*)\s+(INTEGER|VARCHAR|NUMERIC|RECORD|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|VARRAY|TABLE|CURSOR|ROWTYPE|DECIMAL|MONEY)\b/gi;
        const matches = findPatternMatches(declareMatch[1], varPattern);

        for (const match of matches) {
            const varName = match[1];
            if (!/^v_/i.test(varName)) {
                const absoluteOffset = procBody.startOffset + declareMatch.index + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Variable '${varName}' should use v_ prefix`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + varName.length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP017: CASE without END CASE
// FIXED: Better detection of CASE statements
// ============================================================================
export const ruleNZP017: LintRule = {
    id: 'NZP017',
    name: 'Unmatched CASE Statement',
    description: 'CASE statement must be closed with END CASE or END',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP017')) return issues;
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        const caseStarts = findPatternMatches(
            procBody.body,
            /\bCASE\s+(?:WHEN|[a-z_][a-z0-9_]*\s+WHEN)/gi
        );

        let unmatchedCases = 0;
        for (const caseStart of caseStarts) {
            if (!hasMatchingSqlCaseEnd(procBody.body, caseStart.index)) {
                unmatchedCases++;
            }
        }

        if (unmatchedCases > 0) {
            const offset = procBody.startOffset;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Unmatched CASE expressions (${unmatchedCases} without matching END or END CASE)`,
                severity: this.defaultSeverity,
                startOffset: offset,
                endOffset: offset + 10
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP018: SQL Injection risk with EXECUTE IMMEDIATE
// ============================================================================
export const ruleNZP018: LintRule = {
    id: 'NZP018',
    name: 'SQL Injection Risk',
    description: 'EXECUTE IMMEDIATE with concatenated variables may be vulnerable to SQL injection',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        // Look for EXECUTE IMMEDIATE with concatenation
        const pattern = /EXECUTE\s+IMMEDIATE\s+[^;]*?\|\|/gi;
        const matches = findPatternMatches(procBody.body, pattern);

        for (const match of matches) {
            const absoluteOffset = procBody.startOffset + match.index;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: EXECUTE IMMEDIATE with string concatenation may be vulnerable to SQL injection. Use USING clause instead.`,
                severity: this.defaultSeverity,
                startOffset: absoluteOffset,
                endOffset: absoluteOffset + 17
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP019: Missing DEFAULT for parameters
// ============================================================================
export const ruleNZP019: LintRule = {
    id: 'NZP019',
    name: 'Optional Parameter Without Default',
    description: 'Consider adding DEFAULT values for optional parameters',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];

        const procPattern = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+\w+\s*\(([\s\S]*?)\)/i;
        const procMatch = procPattern.exec(sql);

        if (!procMatch) return issues;

        const params = procMatch[2];
        const lines = params.split(',');

        // Check if last parameter has DEFAULT
        if (lines.length > 1) {
            const lastParam = lines[lines.length - 1];
            if (!/\bDEFAULT\b/i.test(lastParam)) {
                const offset = procMatch.index + procMatch[0].indexOf(lastParam);
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Consider adding DEFAULT value for last parameter if it's optional`,
                    severity: this.defaultSeverity,
                    startOffset: offset,
                    endOffset: offset + lastParam.length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP020: Implicit type conversion
// ============================================================================
export const ruleNZP020: LintRule = {
    id: 'NZP020',
    name: 'Implicit Type Conversion',
    description: 'Use explicit CAST() for type conversions',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);

        if (!procBody) return issues;

        // FIXED: Better pattern - detect string/number concatenation without CAST
        const pattern = /(?:VARCHAR|TEXT|CHAR|NCHAR|NVARCHAR)\s*\|\|\s*\d+|\d+\s*\|\|\s*(?:VARCHAR|TEXT|CHAR|NCHAR|NVARCHAR)/gi;
        const matches = findPatternMatches(procBody.body, pattern);

        for (const match of matches) {
            if (!/CAST\(/i.test(match[0])) {
                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Consider using explicit CAST() for type conversion`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + match[0].length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP022: OUT Parameter Without Assignment
// ============================================================================
export const ruleNZP022: LintRule = {
    id: 'NZP022',
    name: 'OUT Parameter Without Assignment',
    description: 'OUT/INOUT parameters must be assigned a value before RETURN',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP022')) return issues;
        const procPattern = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+\w+\s*\(([\s\S]*?)\)/i;
        const procMatch = procPattern.exec(sql);

        if (!procMatch) return issues;

        const params = procMatch[2];
        const outParamPattern = /\b(OUT|INOUT)\s+([a-z_][a-z0-9_]*)\s+/gi;
        const outParamMatches = findPatternMatches(params, outParamPattern);

        if (outParamMatches.length > 0) {
            const procBody = extractProcedureBody(sql);
            if (!procBody) return issues;

            for (const outParam of outParamMatches) {
                const paramName = outParam[2];
                // Check if parameter is assigned via :=, SELECT INTO, or FOR loop record
                // FIXED: Use word boundaries for accurate matching
                const assignPattern = new RegExp(`\\b${paramName}\\s*:=|\\bINTO\\b[^;]*\\b${paramName}\\b|\\bFOR\\s+${paramName}\\s+IN\\b`, 'i');

                const cleanedBody = removeCommentsAndStrings(procBody.body);
                if (!assignPattern.test(cleanedBody)) {
                    const absoluteOffset = procMatch.index + procMatch[0].indexOf(params) + outParam.index;
                    issues.push({
                        ruleId: this.id,
                        message: `${this.id}: OUT/INOUT parameter '${paramName}' is possibly not assigned a value`,
                        severity: this.defaultSeverity,
                        startOffset: absoluteOffset,
                        endOffset: absoluteOffset + outParam[0].length
                    });
                }
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP023: Unclosed Cursor (deprecated)
// NZPLSQL uses implicit cursors via FOR rec IN SELECT ... LOOP, not OPEN/CLOSE.
// ============================================================================
export const ruleNZP023: LintRule = {
    id: 'NZP023',
    name: 'Unclosed Cursor (deprecated)',
    description:
        'Deprecated: NZPLSQL does not use PL/SQL-style OPEN/CLOSE cursors. Use FOR rec IN SELECT ... LOOP instead.',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(_sql: string): LintIssue[] {
        return [];
    }
};

// ============================================================================
// RULE NZP024: Missing RETURN Statement
// ============================================================================
export const ruleNZP024: LintRule = {
    id: 'NZP024',
    name: 'Missing RETURN Statement',
    description: 'Procedure with RETURNS type must have RETURN statement',
    defaultSeverity: LintSeverity.Error,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        if (shouldSkipCstMigratedProcedureRule(sql, 'NZP024')) return issues;

        // Check if procedure has RETURNS clause
        const returnsMatch = /\bRETURNS\s+(\w+)/i.exec(sql);
        if (!returnsMatch) {
            return issues; // No RETURNS, no problem
        }

        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        // Check for RETURN statement
        if (!/\bRETURN\b/i.test(procBody.body)) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Procedure declares RETURNS ${returnsMatch[1]} but has no RETURN statement`,
                severity: this.defaultSeverity,
                startOffset: procBody.startOffset,
                endOffset: procBody.startOffset + 20
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP025: Transaction Control in Procedure
// ============================================================================
export const ruleNZP025: LintRule = {
    id: 'NZP025',
    name: 'Transaction Control in Procedure',
    description: 'COMMIT/ROLLBACK should not be used inside stored procedures',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        const txPattern = /\b(COMMIT|ROLLBACK)(?!\s+TO\s+SAVEPOINT)\b/gi;
        const matches = findPatternMatches(procBody.body, txPattern);

        for (const match of matches) {
            const absoluteOffset = procBody.startOffset + match.index;
            issues.push({
                ruleId: this.id,
                message: `${this.id}: ${match[0]} inside procedure may cause unexpected behavior. Consider using SAVEPOINT instead.`,
                severity: this.defaultSeverity,
                startOffset: absoluteOffset,
                endOffset: absoluteOffset + match[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP026: Use PERFORM for Discarded Results
// ============================================================================
export const ruleNZP026: LintRule = {
    id: 'NZP026',
    name: 'Use PERFORM for Discarded Results',
    description: 'Use PERFORM instead of SELECT when result is not needed',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        // Find SELECT statements that call functions without INTO
        const pattern = /\bSELECT\s+[a-z_][a-z0-9_]*\s*\([^)]*\)\s*;/gi;
        const matches = findPatternMatches(procBody.body, pattern);

        for (const match of matches) {
            if (!/\bINTO\b/i.test(match[0])) {
                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Consider using PERFORM instead of SELECT when result is discarded`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + 6
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP027: Missing EXECUTE AS Clause
// ============================================================================
export const ruleNZP027: LintRule = {
    id: 'NZP027',
    name: 'Missing EXECUTE AS Clause',
    description: 'Consider explicitly specifying EXECUTE AS OWNER or EXECUTE AS CALLER',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];

        const createMatch = /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
        if (!createMatch) return issues;

        if (!/\bEXECUTE\s+AS\s+(OWNER|CALLER)\b/i.test(sql)) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Missing EXECUTE AS clause (defaults to OWNER). Consider making it explicit.`,
                severity: this.defaultSeverity,
                startOffset: createMatch.index,
                endOffset: createMatch.index + createMatch[0].length
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP028: VARRAY without EXTEND
// ============================================================================
export const ruleNZP028: LintRule = {
    id: 'NZP028',
    name: 'VARRAY Assignment Without EXTEND',
    description: 'VARRAY elements should be initialized with EXTEND before assignment',
    defaultSeverity: LintSeverity.Warning,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        // Find VARRAY declarations
        const varrayPattern = /\b([a-z_][a-z0-9_]*)\s+VARRAY/gi;
        const varrayMatches = findPatternMatches(procBody.body, varrayPattern);

        for (const varrayMatch of varrayMatches) {
            const arrayName = varrayMatch[1];

            // Check if there's assignment to array without EXTEND
            // Support variable indices like v_arr(v_idx)
            const assignPattern = new RegExp(`\\b${arrayName}\\s*\\(\\s*[a-z0-9_]+\\s*\\)\\s*:=`, 'gi');
            const extendPattern = new RegExp(`\\b${arrayName}\\.EXTEND`, 'i');

            const cleanedBody = removeCommentsAndStrings(procBody.body);
            const assignments = findPatternMatches(cleanedBody, assignPattern);
            const hasExtend = extendPattern.test(cleanedBody);

            if (assignments.length > 0 && !hasExtend) {
                const absoluteOffset = procBody.startOffset + varrayMatch.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: VARRAY '${arrayName}' assigned without EXTEND. Initialize with .EXTEND() first.`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + varrayMatch[0].length
                });
            }
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP029: Nested Exception Blocks
// ============================================================================
export const ruleNZP029: LintRule = {
    id: 'NZP029',
    name: 'Deep Exception Nesting',
    description: 'Avoid deeply nested exception blocks - consider refactoring',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        // Count nested BEGIN...EXCEPTION...END blocks
        let depth = 0;
        let maxDepth = 0;
        const cleanedBody = removeCommentsAndStrings(procBody.body);
        const lines = cleanedBody.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/\bBEGIN\b/i.test(line) && !/\bBEGIN_PROC\b/i.test(line)) {
                depth++;
                maxDepth = Math.max(maxDepth, depth);
            }
            if (/\bEND\b/i.test(line) && !/\bEND\s+(IF|LOOP|CASE|_PROC)\b/i.test(line)) {
                depth--;
            }
        }

        if (maxDepth > 3) {
            issues.push({
                ruleId: this.id,
                message: `${this.id}: Deep exception nesting detected (${maxDepth} levels). Consider refactoring into separate procedures.`,
                severity: this.defaultSeverity,
                startOffset: procBody.startOffset,
                endOffset: procBody.startOffset + 20
            });
        }

        return issues;
    }
};

// ============================================================================
// RULE NZP030: Using SQLSTATE vs Named Exceptions
// ============================================================================
export const ruleNZP030: LintRule = {
    id: 'NZP030',
    name: 'Use Named Exceptions',
    description: 'Use named exceptions (NO_DATA_FOUND, etc.) instead of SQLSTATE codes',
    defaultSeverity: LintSeverity.Information,
    onDemandOnly: PROCEDURE_ON_DEMAND_ONLY,
    check(sql: string): LintIssue[] {
        const issues: LintIssue[] = [];
        const procBody = extractProcedureBody(sql);
        if (!procBody) return issues;

        // Look for SQLSTATE '02000' (NO_DATA_FOUND) or other common codes
        const sqlstatePattern = /\bWHEN\s+SQLSTATE\s+'(\d{5})'/gi;
        const matches = findPatternMatches(procBody.body, sqlstatePattern);

        const namedExceptions: { [key: string]: string } = {
            '02000': 'NO_DATA_FOUND',
            '23505': 'UNIQUE_VIOLATION',
            '23503': 'FOREIGN_KEY_VIOLATION',
            '42P01': 'UNDEFINED_TABLE'
        };

        for (const match of matches) {
            const sqlstate = match[1];
            if (namedExceptions[sqlstate]) {
                const absoluteOffset = procBody.startOffset + match.index;
                issues.push({
                    ruleId: this.id,
                    message: `${this.id}: Use named exception ${namedExceptions[sqlstate]} instead of SQLSTATE '${sqlstate}'`,
                    severity: this.defaultSeverity,
                    startOffset: absoluteOffset,
                    endOffset: absoluteOffset + match[0].length
                });
            }
        }

        return issues;
    }
};

/**
 * All procedure-specific lint rules
 */
export const procedureRules: LintRule[] = [
    ruleNZP001, ruleNZP002, ruleNZP003, ruleNZP004, ruleNZP005,
    ruleNZP006, ruleNZP007, ruleNZP008, ruleNZP009, ruleNZP010,
    ruleNZP011, ruleNZP012, ruleNZP013, ruleNZP014, ruleNZP015,
    ruleNZP016, ruleNZP017, ruleNZP018, ruleNZP019, ruleNZP020,
    ruleNZP022, ruleNZP023, ruleNZP024, ruleNZP025, ruleNZP026,
    ruleNZP027, ruleNZP028, ruleNZP029, ruleNZP030
];

/**
 * Main linter function for procedures
 */
export function lintNetezzaProcedure(sql: string): LintIssue[] {
    const allIssues: LintIssue[] = [];

    beginProcedureRuleEvaluation();
    warmProcedureParseGate(sql);
    try {
        for (const rule of procedureRules) {
            const issues = rule.check(sql);
            allIssues.push(...issues);
        }
    } finally {
        endProcedureRuleEvaluation();
    }

    // Sort by offset
    return allIssues.sort((a, b) => a.startOffset - b.startOffset);
}

/**
 * Get a procedure rule by its ID
 */
export function getProcedureRuleById(id: string): LintRule | undefined {
    return procedureRules.find(rule => rule.id === id);
}
