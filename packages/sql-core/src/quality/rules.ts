import type {
  DatabaseSqlLintIssue,
  DatabaseSqlQualityRule,
} from "@justybase/contracts";
import { parseNetezzaSqlStatements } from "../parser/runtime";
import {
  findPatternMatches,
  findPatternMatchesInRange,
  findPatternMatchesPreservingDoubleQuotedIdentifiers,
  findFirstKeywordInRange,
  hasKeywordInRange as hasSourceKeywordInRange,
  indexOfStatementSemicolon,
  indexOfWhereClauseEnd,
  removeCommentsAndStrings,
  splitSqlStatementsWithOffsets,
} from "./sourceScan";
import { isInsideStringOrComment } from "../sourceScan";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "ON", "AND", "OR", "INSERT", "INTO", "UPDATE", "DELETE", "CREATE",
  "DROP", "ALTER", "TABLE", "VIEW", "INDEX", "ORDER", "BY", "GROUP", "HAVING",
  "UNION", "ALL", "DISTINCT", "AS", "SET", "VALUES", "NULL", "NOT", "IN",
  "BETWEEN", "LIKE", "IS", "EXISTS", "CASE", "WHEN", "THEN", "ELSE",
  "END", "LIMIT", "OFFSET", "TRUNCATE",
];

const PARSER_OWNED_RULES = new Set([
  "NZ002", "NZ003", "NZ004", "NZ010", "NZ011", "NZ012", "NZ016",
  "NZ019", "NZ021", "NZ022", "NZ023",
]);

function maskSql(sql: string): string {
  return removeCommentsAndStrings(sql);
}

function findMatches(sql: string, pattern: RegExp): RegExpExecArray[] {
  return findPatternMatches(sql, pattern);
}

function findMatchesPreservingDoubleQuotedIdentifiers(
  sql: string,
  pattern: RegExp,
): RegExpExecArray[] {
  return findPatternMatchesPreservingDoubleQuotedIdentifiers(sql, pattern);
}

function hasKeywordInRange(
  masked: string,
  startOffset: number,
  endOffset: number,
  pattern: RegExp,
): boolean {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags).test(masked.slice(startOffset, endOffset));
}

function issue(
  ruleId: string,
  message: string,
  severity: DatabaseSqlLintIssue["severity"],
  startOffset: number,
  endOffset: number,
  suggestedFix?: string,
): DatabaseSqlLintIssue {
  return {
    ruleId,
    message: `${ruleId}: ${message}`,
    severity,
    startOffset,
    endOffset: Math.max(startOffset + 1, endOffset),
    suggestedFix,
  };
}

function regexRule(
  id: string,
  name: string,
  description: string,
  defaultSeverity: DatabaseSqlLintIssue["severity"],
  pattern: RegExp,
  span: (match: RegExpExecArray) => { start: number; end: number; fix?: string } = (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }),
): DatabaseSqlQualityRule {
  return {
    id,
    name,
    description,
    defaultSeverity,
    check(sql) {
      const masked = maskSql(sql);
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const matcher = new RegExp(pattern.source, flags);
      const results: DatabaseSqlLintIssue[] = [];
      let match = matcher.exec(masked);
      while (match) {
        const range = span(match);
        results.push(issue(id, description, defaultSeverity, range.start, range.end, range.fix));
        match = matcher.exec(masked);
      }
      return results;
    },
  };
}

function statementEnd(masked: string, offset: number): number {
  const semicolon = masked.indexOf(";", offset);
  return semicolon < 0 ? masked.length : semicolon;
}

function findMatchingParen(sql: string, openParenOffset: number): number {
  let depth = 0;
  for (let index = openParenOffset; index < sql.length; index += 1) {
    if (isInsideStringOrComment(sql, index)) continue;
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function buildParenthesizedClauseRanges(
  sql: string,
  openerPattern: RegExp,
): Array<{ start: number; end: number }> {
  return findMatches(sql, openerPattern).flatMap((match) => {
    const openParenOffset = match.index + match[0].lastIndexOf("(");
    const closeParenOffset = findMatchingParen(sql, openParenOffset);
    return closeParenOffset > openParenOffset
      ? [{ start: openParenOffset, end: closeParenOffset }]
      : [];
  });
}

const ruleNZ001 = regexRule(
  "NZ001",
  "Select Star",
  "Avoid using SELECT * - specify explicit column names for better performance and maintainability",
  1,
  /\bSELECT\s+\*/gi,
  (match) => ({ start: match.index + match[0].lastIndexOf("*"), end: match.index + match[0].lastIndexOf("*") + 1 }),
);

const ruleNZ005: DatabaseSqlQualityRule = {
  id: "NZ005",
  name: "Leading Wildcard Like",
  description: "LIKE pattern with leading wildcard ('%...') prevents Zone Map pruning",
  defaultSeverity: 3,
  check(sql) {
    return findMatches(sql, /\bLIKE\s+'%/gi)
      .map((match) => issue(this.id, this.description, this.defaultSeverity, match.index, match.index + match[0].length));
  },
};

const ruleNZ006: DatabaseSqlQualityRule = {
  id: "NZ006",
  name: "Order By Without Limit",
  description: "ORDER BY without LIMIT/FETCH may cause performance issues on large datasets",
  defaultSeverity: 2,
  check(sql) {
    const excludedRanges = [
      ...buildParenthesizedClauseRanges(sql, /\bOVER\s*\(/gi),
      ...buildParenthesizedClauseRanges(sql, /\bWITHIN\s+GROUP\s*\(/gi),
    ];
    return findMatches(sql, /\bORDER\s+BY\b/gi).flatMap((match) => {
      if (excludedRanges.some((range) => match.index > range.start && match.index < range.end)) return [];
      const statementEnd = indexOfStatementSemicolon(sql, match.index);
      const hasLimit = hasSourceKeywordInRange(sql, match.index + match[0].length, statementEnd, /\b(LIMIT|FETCH|TOP)\b/i)
        || hasSourceKeywordInRange(sql, 0, match.index, /\bTOP\s+\d+\b/i);
      return hasLimit ? [] : [issue(this.id, this.description, this.defaultSeverity, match.index, match.index + match[0].length)];
    });
  },
};

const ruleNZ007: DatabaseSqlQualityRule = {
  id: "NZ007",
  name: "Inconsistent Keyword Case",
  description: "SQL keywords have inconsistent casing - consider using consistent UPPER or lower case",
  defaultSeverity: 1,
  check(sql) {
    const occurrences: Array<{ index: number; text: string; type: "UPPER" | "lower" | "Mixed" }> = [];
    const processedIndices = new Set<number>();
    for (const keyword of KEYWORDS) {
      const matcher = new RegExp(`\\b${keyword}\\b`, "gi");
      for (const match of findMatches(sql, matcher)) {
        if (processedIndices.has(match.index)) continue;
        processedIndices.add(match.index);
        const type = match[0] === match[0].toUpperCase()
          ? "UPPER"
          : match[0] === match[0].toLowerCase()
            ? "lower"
            : "Mixed";
        occurrences.push({ index: match.index, text: match[0], type });
      }
    }
    const upper = occurrences.filter(({ type }) => type === "UPPER").length;
    const lower = occurrences.filter(({ type }) => type === "lower").length;
    const expectedUpper = upper >= lower;
    return occurrences
      .flatMap(({ index, text, type }) => {
        if (type === "Mixed") {
          return [issue(this.id, `Keyword '${text}' has mixed casing (expected ${expectedUpper ? "UPPERCASE" : "lowercase"})`, this.defaultSeverity, index, index + text.length)];
        }
        return type === (expectedUpper ? "UPPER" : "lower")
          ? []
          : [issue(this.id, `Keyword '${text}' should be ${expectedUpper ? "UPPERCASE" : "lowercase"}`, this.defaultSeverity, index, index + text.length)];
      });
  },
};

const ruleNZ008 = regexRule(
  "NZ008",
  "Truncate Table",
  "TRUNCATE removes all data and cannot be rolled back - use with caution",
  1,
  /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_][A-Za-z0-9_$."]*/gi,
  (match) => ({ start: match.index, end: match.index + "TRUNCATE".length }),
);

const ruleNZ009: DatabaseSqlQualityRule = {
  id: "NZ009",
  name: "Or In Where Clause",
  description: "Multiple OR conditions may prevent Zone Map pruning - consider UNION for better performance",
  defaultSeverity: 3,
  check(sql) {
    return findMatches(sql, /\bWHERE\b/gi).flatMap((where) => {
      const statementEnd = indexOfStatementSemicolon(sql, where.index);
      const whereEnd = indexOfWhereClauseEnd(sql, where.index + where[0].length, statementEnd);
      const ors = findPatternMatchesInRange(sql, where.index, whereEnd, /\bOR\b/gi);
      const firstOr = ors[0];
      return ors.length >= 2 && firstOr
        ? [issue(this.id, `${this.description} (${ors.length} OR conditions found)`, this.defaultSeverity, firstOr.index, firstOr.index + firstOr[0].length)]
        : [];
    });
  },
};

const ruleNZ013 = regexRule(
  "NZ013",
  "Prefer Union All",
  "UNION performs a distinct operation which is slower than UNION ALL. Use UNION ALL if duplicates are not an issue.",
  2,
  /\bUNION\b(?!\s+ALL\b)/gi,
);

const ruleNZ014: DatabaseSqlQualityRule = {
  id: "NZ014",
  name: "Or In Join Condition",
  description: "OR in JOIN condition can cause Cartesian product and severe performance degradation",
  defaultSeverity: 0,
  check(sql) {
    const pattern = /\bJOIN\s+[\w.]+(?:\s+(?:AS\s+)?[\w]+)?\s+ON\b(?:(?!\bWHERE\b|\bJOIN\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b).)*?\bOR\b/gi;
    return findMatches(sql, pattern).flatMap((match) => {
      const orMatch = /\bOR\b/i.exec(match[0]);
      return orMatch
        ? [issue(this.id, this.description, this.defaultSeverity, match.index + orMatch.index, match.index + orMatch.index + orMatch[0].length)]
        : [];
    });
  },
};

const ruleNZ015: DatabaseSqlQualityRule = {
  id: "NZ015",
  name: "Function in Where Clause",
  description: "Using functions in WHERE clauses prevents Zone Map pruning. Use range comparisons where possible.",
  defaultSeverity: 1,
  check(sql) {
    const issues: DatabaseSqlLintIssue[] = [];
    for (const where of findMatches(sql, /\bWHERE\b/gi)) {
      const searchStart = where.index + where[0].length;
      const statementEnd = indexOfStatementSemicolon(sql, where.index);
      const whereEnd = indexOfWhereClauseEnd(sql, searchStart, statementEnd);
      const functionPattern = /\b([A-Z_][A-Z0-9_]*)\s*\(\s*([A-Z_][A-Z0-9_]*(?:\.[A-Z_][A-Z0-9_]*)?)\s*(?:,|\))/gi;
      for (const match of findPatternMatchesInRange(sql, searchStart, whereEnd, functionPattern)) {
        issues.push(issue(this.id, this.description, this.defaultSeverity, match.index, match.index + match[0].length));
      }
    }
    return issues;
  },
};

const ruleNZ017: DatabaseSqlQualityRule = {
  id: "NZ017",
  name: "Double Quoted Identifiers",
  description: "Using double quotes for identifiers makes them case-sensitive, which can lead to \"Object not found\" errors in Netezza.",
  defaultSeverity: 2,
  check(sql) {
    return findMatchesPreservingDoubleQuotedIdentifiers(sql, /"[\w ]+"/g)
      .map((match) => issue(this.id, this.description, this.defaultSeverity, match.index, match.index + match[0].length));
  },
};

const ruleNZ018: DatabaseSqlQualityRule = {
  id: "NZ018",
  name: "Self Referential Join",
  description: "JOIN/WHERE condition compares the same column to itself - this is redundant and may cause performance issues",
  defaultSeverity: 1,
  check(sql) {
    const pattern = /\b(?:ON|WHERE|AND|OR)\b[^=!<>]*?\b([\w.]+)\s*=\s*\b\1\b/gi;
    return findMatches(sql, pattern).flatMap((match) => {
      if (/^\s*WHERE\b/i.test(match[0]) && match[1] === "1") return [];
      const identifierStart = match[0].indexOf(match[1]);
      return [issue(this.id, `${this.description} (found '${match[1]}')`, this.defaultSeverity, match.index + identifierStart, match.index + identifierStart + match[1].length)];
    });
  },
};

const ruleNZ020 = regexRule(
  "NZ020",
  "Subquery Efficiency",
  "Consider using EXISTS or INNER JOIN instead of IN (SELECT ...) for better performance on large datasets.",
  2,
  /\bIN\s*\(\s*SELECT\b/gi,
);

function isTopLevelSelectStatement(sql: string, start: number, end: number): boolean {
  const segment = sql.substring(start, end);
  const contentStart = start + segment.length - segment.trimStart().length;
  const trimmed = sql.substring(contentStart, end);
  if (/^SELECT\b/i.test(trimmed)) return true;
  return /^WITH\b/i.test(trimmed) && /\)\s*SELECT\b/i.test(trimmed);
}

const ruleNZ022: DatabaseSqlQualityRule = {
  id: "NZ022",
  name: "Where Without From",
  description: "WHERE clause used without FROM clause - SELECT statements with WHERE require a FROM clause",
  defaultSeverity: 1,
  check(sql) {
    const issues: DatabaseSqlLintIssue[] = [];
    for (const statement of splitSqlStatementsWithOffsets(sql)) {
      if (!isTopLevelSelectStatement(sql, statement.startOffset, statement.endOffset)) continue;
      const select = findFirstKeywordInRange(sql, statement.startOffset, statement.endOffset, /\bSELECT\b/i);
      if (!select) continue;
      const afterSelect = select.index + select[0].length;
      const where = findFirstKeywordInRange(sql, afterSelect, statement.endOffset, /\bWHERE\b/i);
      if (!where) continue;
      if (!hasSourceKeywordInRange(sql, afterSelect, where.index, /\bFROM\b/i)) {
        issues.push(issue(this.id, this.description, this.defaultSeverity, where.index, where.index + where[0].length));
      }
    }
    return issues;
  },
};

const ruleNZ002: DatabaseSqlQualityRule = {
  id: "NZ002",
  name: "Delete Without Where",
  description: "DELETE statement without WHERE clause will delete all rows",
  defaultSeverity: 0,
  check(sql) {
    const masked = maskSql(sql);
    return findMatches(sql, /\bDELETE\s+FROM\s+[A-Za-z_][A-Za-z0-9_$."]*/gi).flatMap((match) => {
      const end = statementEnd(masked, match.index);
      return hasKeywordInRange(masked, match.index + match[0].length, end, /\bWHERE\b/i)
        ? []
        : [issue(this.id, this.description, this.defaultSeverity, match.index, match.index + 6)];
    });
  },
};

const ruleNZ003: DatabaseSqlQualityRule = {
  id: "NZ003",
  name: "Update Without Where",
  description: "UPDATE statement without WHERE clause will update all rows",
  defaultSeverity: 0,
  check(sql) {
    const masked = maskSql(sql);
    return findMatches(sql, /\bUPDATE\s+[A-Za-z_][A-Za-z0-9_$."]*\s+SET\b/gi).flatMap((match) => {
      const end = statementEnd(masked, match.index);
      return hasKeywordInRange(masked, match.index + match[0].length, end, /\bWHERE\b/i)
        ? []
        : [issue(this.id, this.description, this.defaultSeverity, match.index, match.index + 6)];
    });
  },
};

const ruleNZ004 = regexRule(
  "NZ004",
  "Cross Join",
  "CROSS JOIN produces a Cartesian product - verify this is intentional",
  1,
  /\bCROSS\s+JOIN\b/gi,
);

const ruleNZ010 = regexRule(
  "NZ010",
  "Missing Table Alias",
  "Consider using table aliases in JOINs for better readability",
  2,
  /\bJOIN\s+[A-Za-z_][A-Za-z0-9_$."]*\s+ON\b/gi,
);

const ruleNZ011 = regexRule(
  "NZ011",
  "CTAS Missing Distribution",
  "CREATE TABLE AS SELECT should specify explicit data distribution",
  1,
  /\bCREATE\s+TABLE\b[\s\S]*?\bAS\s+(?:\(\s*)?SELECT\b/gi,
);

const ruleNZ012 = regexRule(
  "NZ012",
  "Update Alias With AS",
  "Netezza UPDATE aliases must not use AS",
  0,
  /\bUPDATE\s+[A-Za-z_][A-Za-z0-9_$."]*\s+AS\s+[A-Za-z_][A-Za-z0-9_$]*/gi,
  (match) => {
    const start = match.index + match[0].toUpperCase().indexOf("AS");
    return { start, end: start + 2 };
  },
);

const ruleNZ016 = regexRule(
  "NZ016",
  "Implicit Casting in Join",
  "Avoid joining columns with different data types",
  1,
  /\bJOIN\b[\s\S]*?\bON\b[\s\S]*?['"]/gi,
);

const ruleNZ019 = regexRule(
  "NZ019",
  "Case Without End",
  "CASE expression must end with END",
  0,
  /\bCASE\b/gi,
);

const ruleNZ021 = regexRule(
  "NZ021",
  "Double Comma",
  "Consecutive commas indicate a missing expression or an extra comma",
  0,
  /,,/g,
  (match) => ({ start: match.index + 1, end: match.index + 2 }),
);

/**
 * Netezza quality rules owned by sql-core. Parser-owned ids remain exported
 * for configuration compatibility but are intentionally not executed here.
 */
export const netezzaSqlQualityRules: readonly DatabaseSqlQualityRule[] = [
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
  ruleNZ022,
].filter((rule) => !PARSER_OWNED_RULES.has(rule.id));

export const parserOwnedNetezzaQualityRuleIds = PARSER_OWNED_RULES;

const PROCEDURE_ON_DEMAND_RULES = new Set([
  "NZP007", "NZP009", "NZP014", "NZP015", "NZP016", "NZP018",
  "NZP019", "NZP020", "NZP025", "NZP026", "NZP027", "NZP028",
  "NZP029", "NZP030",
]);
const PROCEDURE_REGEX_FALLBACK_RULES = new Set([
  "NZP004", "NZP005", "NZP006", "NZP008", "NZP011", "NZP013",
  "NZP017", "NZP022", "NZP024",
]);

interface ProcedureBody {
  body: string;
  startOffset: number;
}

function hasProcedureDeclaration(sql: string): boolean {
  return findPatternMatches(sql, /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i).length > 0;
}

function extractProcedureBody(sql: string): ProcedureBody | undefined {
  const declaration = findPatternMatches(sql, /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i)[0];
  if (!declaration) return undefined;

  const begin = findPatternMatches(sql, /\bBEGIN_PROC\b/gi)
    .find((match) => match.index >= declaration.index + declaration[0].length);
  if (begin) {
    const end = findPatternMatches(sql, /\bEND_PROC\b/gi)
      .find((match) => match.index > begin.index + begin[0].length);
    if (!end) return undefined;
    return {
      body: sql.slice(begin.index, end.index + end[0].length),
      startOffset: begin.index,
    };
  }

  const stringBody = /\bAS\s+'((?:[^']|'')*)'\s*;?/i.exec(sql.slice(declaration.index + declaration[0].length));
  if (!stringBody) return undefined;
  const relativeQuoteStart = stringBody.index + stringBody[0].indexOf("'") + 1;
  const startOffset = declaration.index + declaration[0].length + relativeQuoteStart;
  return {
    body: stringBody[1].replace(/''/g, "'"),
    startOffset,
  };
}

function shouldUseProcedureRegexFallback(sql: string, ruleId: string): boolean {
  if (!PROCEDURE_REGEX_FALLBACK_RULES.has(ruleId)) return true;
  try {
    const parsed = parseNetezzaSqlStatements({ sql });
    return parsed.cst === undefined
      || parsed.lexResult.errors.length > 0
      || parsed.actionableParserErrors.length > 0;
  } catch {
    return true;
  }
}

function parenthesisDepthBefore(sql: string, offset: number): number {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (isInsideStringOrComment(sql, index)) continue;
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function statementPrefixBefore(sql: string, offset: number): string {
  const statements = sql.slice(0, offset).split(";");
  return statements[statements.length - 1] ?? "";
}

function isEmbeddedDmlSelect(sql: string, selectOffset: number): boolean {
  if (parenthesisDepthBefore(sql, selectOffset) > 0) return true;
  const prefix = statementPrefixBefore(sql, selectOffset);
  return /\bINSERT\s+INTO\b/i.test(prefix)
    || /\bCREATE\s+(?:TEMP\s+)?TABLE\b[\s\S]*\bAS\s*\(\s*$/i.test(prefix)
    || /\bCURSOR\s+FOR\s*$/i.test(prefix)
    || /\bWITH\b[\s\S]*\bAS\s*\(\s*$/i.test(prefix);
}

const PROCEDURAL_END_PATTERN = /\bEND\b(?!\s*(_PROC|IF|LOOP|CASE|TRANSACTION|WORK)\b)(?!\s*(AS|,|\)))/gi;

function hasMatchingSqlCaseEnd(sql: string, caseOffset: number): boolean {
  const statementEnd = indexOfStatementSemicolon(sql, caseOffset);
  const segment = sql.substring(caseOffset, statementEnd);
  let depth = 0;
  for (const match of findMatches(segment, /\b(CASE|END\s+CASE|END)\b/gi)) {
    const token = match[0].toUpperCase().replace(/\s+/g, " ");
    const after = segment.substring(match.index + match[0].length);
    if (token === "CASE") {
      depth += 1;
    } else if (token === "END CASE") {
      depth -= 1;
      if (depth === 0) return true;
    } else if (token === "END") {
      if (/^\s*(IF|LOOP|CASE|_PROC|TRANSACTION|WORK)\b/i.test(after)) continue;
      if (depth === 1 && (
        /^\s*,/.test(after)
        || /^\s*\)/.test(after)
        || /^\s*(AS|FROM)\b/i.test(after)
        || /^\s*;/.test(after)
        || /^\s*$/.test(after)
      )) {
        depth -= 1;
        if (depth === 0) return true;
      }
    }
  }
  return false;
}

function procedureRule(
  id: string,
  name: string,
  description: string,
  defaultSeverity: DatabaseSqlLintIssue["severity"],
  check: (sql: string) => DatabaseSqlLintIssue[],
): DatabaseSqlQualityRule {
  return {
    id,
    name,
    description,
    defaultSeverity,
    onDemandOnly: PROCEDURE_ON_DEMAND_RULES.has(id),
    check,
  };
}

function procedureIssue(
  id: string,
  message: string,
  severity: DatabaseSqlLintIssue["severity"],
  startOffset: number,
  endOffset: number,
): DatabaseSqlLintIssue {
  return issue(id, message, severity, startOffset, endOffset);
}

function procedureBodyOrEmpty(sql: string): ProcedureBody | undefined {
  if (!hasProcedureDeclaration(sql)) return undefined;
  return extractProcedureBody(sql);
}

const ruleNZP001 = procedureRule(
  "NZP001",
  "Missing Procedure Delimiters",
  "Stored procedure must have BEGIN_PROC and END_PROC delimiters",
  0,
  (sql) => {
    if (!hasProcedureDeclaration(sql)) return [];
    const cleaned = maskSql(sql);
    const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(cleaned);
    if (!create) return [];
    const results: DatabaseSqlLintIssue[] = [];
    if (!/\bBEGIN_PROC\b/i.test(cleaned)) {
      results.push(procedureIssue("NZP001", "Missing BEGIN_PROC delimiter", 0, create.index, create.index + create[0].length));
    }
    if (!/\bEND_PROC\b/i.test(cleaned)) {
      results.push(procedureIssue("NZP001", "Missing END_PROC delimiter", 0, Math.max(0, sql.length - 10), sql.length));
    }
    return results;
  },
);

const ruleNZP002 = procedureRule(
  "NZP002",
  "Missing Language Specification",
  "Stored procedure must specify LANGUAGE (NZPLSQL, SQL, C, or JAVA)",
  0,
  (sql) => {
    if (!hasProcedureDeclaration(sql)) return [];
    const cleaned = maskSql(sql);
    const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(cleaned);
    return create && !/\bLANGUAGE\s+(?:NZPLSQL|SQL|C|JAVA)\b/i.test(cleaned)
      ? [procedureIssue("NZP002", "Missing LANGUAGE clause (should be NZPLSQL, SQL, C, or JAVA)", 0, create.index, create.index + create[0].length)]
      : [];
  },
);

const ruleNZP003 = procedureRule(
  "NZP003",
  "Missing Return Type",
  "Stored procedure must specify RETURNS type",
  1,
  (sql) => {
    if (!hasProcedureDeclaration(sql)) return [];
    const cleaned = maskSql(sql);
    const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(cleaned);
    return create && !/\bRETURNS\s+\w+/i.test(cleaned)
      ? [procedureIssue("NZP003", "Missing RETURNS clause", 1, create.index, create.index + create[0].length)]
      : [];
  },
);

const ruleNZP004 = procedureRule(
  "NZP004",
  "Unmatched BEGIN/END Blocks",
  "Every BEGIN must have a matching END",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP004")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const begins = findMatches(procedure.body, /\bBEGIN\b(?!\s*(_PROC|TRANSACTION|WORK)\b)/gi).length;
    const ends = findMatches(procedure.body, PROCEDURAL_END_PATTERN).length;
    return begins === ends
      ? []
      : [procedureIssue("NZP004", "Unmatched BEGIN/END blocks (" + begins + " BEGIN vs " + ends + " END)", 0, procedure.startOffset, procedure.startOffset + 10)];
  },
);

const ruleNZP005 = procedureRule(
  "NZP005",
  "Unmatched IF Statement",
  "IF statement must be closed with END IF",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP005")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const begins = findMatches(procedure.body, /(?<!ELS|END\s)\bIF\b(?!\s+(?:NOT\s+)?EXISTS\b)/gi).length;
    const ends = findMatches(procedure.body, /\bEND\s+IF\b/gi).length;
    return begins === ends
      ? []
      : [procedureIssue("NZP005", "Unmatched IF statements (" + begins + " IF vs " + ends + " END IF)", 0, procedure.startOffset, procedure.startOffset + 10)];
  },
);

const ruleNZP006 = procedureRule(
  "NZP006",
  "Unmatched LOOP Statement",
  "LOOP statement must be closed with END LOOP",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP006")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const loops = findMatches(procedure.body, /(?<!END\s)LOOP\b/gi).length;
    const ends = findMatches(procedure.body, /\bEND\s+LOOP\b/gi).length;
    return loops === ends
      ? []
      : [procedureIssue("NZP006", "Unmatched LOOP statements (" + loops + " LOOP constructs vs " + ends + " END LOOP)", 0, procedure.startOffset, procedure.startOffset + 10)];
  },
);

const ruleNZP007 = procedureRule(
  "NZP007",
  "Missing Semicolon",
  "SQL statements should end with semicolon",
  1,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\b(SELECT|INSERT|UPDATE|DELETE|DECLARE)\s+[^;]+?(?=\n\s*\b(BEGIN|END|IF|LOOP|FOR|WHILE|DECLARE|SELECT|INSERT|UPDATE|DELETE|EXCEPTION)\b)/gi)
      .flatMap((match) => {
        const statementType = match[1].toUpperCase();
        if (statementType === "INSERT" && /^INSERT\s+INTO\b/i.test(match[0])) {
          const after = procedure.body.substring(match.index + match[0].length, match.index + match[0].length + 100);
          if (/^\s*SELECT\b/i.test(after)) return [];
        }
        if (statementType === "SELECT") {
          if (/\bINTO\b/i.test(match[0]) || /\(\s*$/.test(match[0].trimEnd()) || isEmbeddedDmlSelect(procedure.body, match.index)) return [];
        }
        return [procedureIssue("NZP007", "Statement may be missing semicolon", 1, procedure.startOffset + match.index + match[0].length - 1, procedure.startOffset + match.index + match[0].length)];
      });
  },
);

const ruleNZP008 = procedureRule(
  "NZP008",
  "Unused Variable",
  "Variable declared but never used",
  2,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP008")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const body = maskSql(procedure.body);
    const declaration = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(body);
    if (!declaration) return [];
    const result: DatabaseSqlLintIssue[] = [];
    const variables = findMatches(declaration[1], /\b([a-z_][a-z0-9_]*)\s+(?:INTEGER|VARCHAR|NUMERIC|RECORD|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|VARRAY|TABLE|CURSOR|ROWTYPE|DECIMAL|MONEY)\b/gi);
    const after = body.slice((declaration.index ?? 0) + declaration[0].length);
    for (const variable of variables) {
      if (!new RegExp("\\b" + variable[1] + "\\b", "i").test(after)) {
        const offset = procedure.startOffset + (declaration.index ?? 0) + variable.index;
        result.push(procedureIssue("NZP008", "Variable '" + variable[1] + "' is declared but never used", 2, offset, offset + variable[1].length));
      }
    }
    return result;
  },
);

const ruleNZP009 = procedureRule(
  "NZP009",
  "Missing Exception Handler",
  "Procedure should have EXCEPTION handler for error handling",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure || /\bEXCEPTION\b/i.test(maskSql(procedure.body))) return [];
    return [procedureIssue("NZP009", "Consider adding EXCEPTION handler for better error handling", 2, procedure.startOffset, procedure.startOffset + 10)];
  },
);

const ruleNZP010 = procedureRule(
  "NZP010",
  "RAISE Without Severity",
  "RAISE should specify severity level",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\bRAISE\b(?!\s+(?:NOTICE|WARNING|ERROR|EXCEPTION))/gi)
      .map((match) => procedureIssue("NZP010", "RAISE should specify severity level", 2, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length));
  },
);

const ruleNZP011 = procedureRule(
  "NZP011",
  "Missing INTO in SELECT (regex fallback)",
  "SELECT in procedure should have INTO clause to store results",
  1,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP011")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /(^|;)\s*SELECT\b[^;]*(?=;|$)/gim).flatMap((match) => {
      const statement = match[0];
      if (/\bINTO\b/i.test(statement)) return [];
      const relative = match.index + Math.max(0, match[0].indexOf("SELECT"));
      if (isEmbeddedDmlSelect(procedure.body, relative)) return [];
      return [procedureIssue("NZP011", "SELECT statement should have INTO clause to store results in variables", 1, procedure.startOffset + relative, procedure.startOffset + relative + 6)];
    });
  },
);

const ruleNZP012 = procedureRule(
  "NZP012",
  "Incorrect ELSIF Syntax",
  "Use ELSIF (not ELSEIF or ELSE IF) in NZPLSQL",
  0,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\b(ELSEIF|ELSE\s+IF)\b/gi)
      .map((match) => procedureIssue("NZP012", "Use ELSIF instead of " + match[0] + " in NZPLSQL", 0, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length));
  },
);

const ruleNZP013 = procedureRule(
  "NZP013",
  "Missing THEN Keyword",
  "IF and ELSIF statements must have THEN keyword",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP013")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /(?<!ELS|END\s)\b(IF|ELSIF)\b(?!\s+(?:NOT\s+)?EXISTS\b)/gi).flatMap((match) => {
      const after = procedure.body.slice(match.index + match[0].length);
      const terminator = /\b(ELSIF|ELSE|END\s+IF)\b|;/i.exec(after);
      const condition = terminator ? after.slice(0, terminator.index) : after;
      return /\bTHEN\b/i.test(condition)
        ? []
        : [procedureIssue("NZP013", match[1].toUpperCase() + " statement missing THEN keyword", 0, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length)];
    });
  },
);

const ruleNZP014 = procedureRule(
  "NZP014",
  "Unconditional EXIT",
  "EXIT in loop should have WHEN condition to avoid infinite loops",
  1,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\bEXIT\b(?!\s+WHEN)/gi)
      .map((match) => procedureIssue("NZP014", "Consider using EXIT WHEN instead of unconditional EXIT", 1, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length));
  },
);

const ruleNZP015 = procedureRule(
  "NZP015",
  "Parameter Naming Convention",
  "Parameters should use prefix (e.g., p_) to distinguish from columns",
  2,
  (sql) => {
    const declaration = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+[^ (]+\s*\(([^)]*)\)/i.exec(sql);
    if (!declaration) return [];
    return findMatches(declaration[1], /\b([a-z_][a-z0-9_]*)\s+(?:(?:IN|OUT|INOUT)\s+)?(?:INTEGER|VARCHAR|NUMERIC|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|VARRAY|TABLE|CURSOR|ROWTYPE|DECIMAL|MONEY)\b/gi).flatMap((parameter) => {
      if (/^(?:p_|in_|out_|inout_)/i.test(parameter[1])) return [];
      const offset = declaration.index + declaration[0].indexOf(declaration[1]) + parameter.index;
      return [procedureIssue("NZP015", "Parameter '" + parameter[1] + "' should use prefix like p_, in_, out_, or inout_", 2, offset, offset + parameter[1].length)];
    });
  },
);

const ruleNZP016 = procedureRule(
  "NZP016",
  "Variable Naming Convention",
  "Variables should use prefix (e.g., v_) to distinguish from columns",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const body = maskSql(procedure.body);
    const declaration = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(body);
    if (!declaration) return [];
    return findMatches(declaration[1], /\b([a-z_][a-z0-9_]*)\s+(?:INTEGER|VARCHAR|NUMERIC|RECORD|DATE|TIMESTAMP|BOOLEAN|INT4|INT8|FLOAT|FLOAT4|FLOAT8|DOUBLE|REAL|BIGINT|SMALLINT|BYTEINT|CHAR|NCHAR|NVARCHAR|TIME|TIMETZ|INTERVAL|VARRAY|TABLE|CURSOR|ROWTYPE|DECIMAL|MONEY)\b/gi).flatMap((variable) => {
      if (/^v_/i.test(variable[1])) return [];
      const offset = procedure.startOffset + (declaration.index ?? 0) + variable.index;
      return [procedureIssue("NZP016", "Variable '" + variable[1] + "' should use v_ prefix", 2, offset, offset + variable[1].length)];
    });
  },
);

const ruleNZP017 = procedureRule(
  "NZP017",
  "Unmatched CASE Statement",
  "CASE statement must be closed with END CASE or END",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP017")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const unmatchedCases = findMatches(procedure.body, /\bCASE\s+(?:WHEN|[a-z_][a-z0-9_]*\s+WHEN)/gi)
      .filter((match) => !hasMatchingSqlCaseEnd(procedure.body, match.index)).length;
    return unmatchedCases === 0
      ? []
      : [procedureIssue("NZP017", "Unmatched CASE expressions (" + unmatchedCases + " without matching END or END CASE)", 0, procedure.startOffset, procedure.startOffset + 10)];
  },
);

const ruleNZP018 = procedureRule(
  "NZP018",
  "SQL Injection Risk",
  "EXECUTE IMMEDIATE with concatenated variables may be vulnerable to SQL injection",
  1,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /EXECUTE\s+IMMEDIATE\s+[^;]*?\|\|/gi)
      .map((match) => procedureIssue("NZP018", "EXECUTE IMMEDIATE with string concatenation may be vulnerable to SQL injection. Use USING clause instead.", 1, procedure.startOffset + match.index, procedure.startOffset + match.index + 17));
  },
);

const ruleNZP019 = procedureRule(
  "NZP019",
  "Optional Parameter Without Default",
  "Consider adding DEFAULT values for optional parameters",
  2,
  (sql) => {
    const declaration = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+[^ (]+\s*\(([^)]*)\)/i.exec(sql);
    if (!declaration || !declaration[1].includes(",")) return [];
    const parameters = declaration[1].split(",");
    const last = parameters.length > 0 ? parameters[parameters.length - 1]!.trim() : "";
    if (!last || /\bDEFAULT\b/i.test(last)) return [];
    const offset = declaration.index + declaration[0].indexOf(declaration[1]) + declaration[1].lastIndexOf(last);
    return [procedureIssue("NZP019", "Consider adding DEFAULT value for last parameter if it's optional", 2, offset, offset + last.length)];
  },
);

const ruleNZP020 = procedureRule(
  "NZP020",
  "Implicit Type Conversion",
  "Use explicit CAST() for type conversions",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /(?:VARCHAR|TEXT|CHAR|NCHAR|NVARCHAR)\s*\|\|\s*\d+|\d+\s*\|\|\s*(?:VARCHAR|TEXT|CHAR|NCHAR|NVARCHAR)/gi)
      .filter((match) => !/CAST\(/i.test(match[0]))
      .map((match) => procedureIssue("NZP020", "Consider using explicit CAST() for type conversion", 2, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length));
  },
);

const ruleNZP022 = procedureRule(
  "NZP022",
  "OUT Parameter Without Assignment",
  "OUT/INOUT parameters must be assigned a value before RETURN",
  1,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP022")) return [];
    const declaration = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+[^ (]+\s*\(([^)]*)\)/i.exec(sql);
    const procedure = procedureBodyOrEmpty(sql);
    if (!declaration || !procedure) return [];
    const body = maskSql(procedure.body);
    return findMatches(declaration[1], /\b(OUT|INOUT)\s+([a-z_][a-z0-9_]*)\s+/gi).flatMap((parameter) => {
      const name = parameter[2];
      const assigned = new RegExp("\\b" + name + "\\s*:=|\\bINTO\\b[^;]*\\b" + name + "\\b|\\bFOR\\s+" + name + "\\s+IN\\b", "i").test(body);
      if (assigned) return [];
      const offset = declaration.index + declaration[0].indexOf(declaration[1]) + parameter.index;
      return [procedureIssue("NZP022", "OUT/INOUT parameter '" + name + "' is possibly not assigned a value", 1, offset, offset + parameter[0].length)];
    });
  },
);

const ruleNZP023 = procedureRule(
  "NZP023",
  "Unclosed Cursor (deprecated)",
  "Deprecated cursor rule",
  1,
  () => [],
);

const ruleNZP024 = procedureRule(
  "NZP024",
  "Missing RETURN Statement",
  "Procedure with RETURNS type must have RETURN statement",
  0,
  (sql) => {
    if (!shouldUseProcedureRegexFallback(sql, "NZP024")) return [];
    const procedure = procedureBodyOrEmpty(sql);
    const returnsMatch = /\bRETURNS\s+(\w+)/i.exec(maskSql(sql));
    if (!procedure || !returnsMatch) return [];
    return /\bRETURN\b/i.test(maskSql(procedure.body))
      ? []
      : [procedureIssue("NZP024", "Procedure declares RETURNS " + returnsMatch[1] + " but has no RETURN statement", 0, procedure.startOffset, procedure.startOffset + 20)];
  },
);

const ruleNZP025 = procedureRule(
  "NZP025",
  "Transaction Control in Procedure",
  "COMMIT/ROLLBACK should not be used inside stored procedures",
  1,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\b(COMMIT|ROLLBACK)(?!\s+TO\s+SAVEPOINT)\b/gi)
      .map((match) => procedureIssue("NZP025", match[0] + " inside procedure may cause unexpected behavior. Consider using SAVEPOINT instead.", 1, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length));
  },
);

const ruleNZP026 = procedureRule(
  "NZP026",
  "Use PERFORM for Discarded Results",
  "Use PERFORM instead of SELECT when result is not needed",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    return findMatches(procedure.body, /\bSELECT\s+[a-z_][a-z0-9_]*\s*\([^)]*\)\s*;/gi)
      .filter((match) => !/\bINTO\b/i.test(match[0]))
      .map((match) => procedureIssue("NZP026", "Consider using PERFORM instead of SELECT when result is discarded", 2, procedure.startOffset + match.index, procedure.startOffset + match.index + 6));
  },
);

const ruleNZP027 = procedureRule(
  "NZP027",
  "Missing EXECUTE AS Clause",
  "Consider explicitly specifying EXECUTE AS OWNER or EXECUTE AS CALLER",
  2,
  (sql) => {
    if (!hasProcedureDeclaration(sql) || /\bEXECUTE\s+AS\s+(?:OWNER|CALLER)\b/i.test(maskSql(sql))) return [];
    const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i.exec(sql);
    return create
      ? [procedureIssue("NZP027", "Missing EXECUTE AS clause (defaults to OWNER). Consider making it explicit.", 2, create.index, create.index + create[0].length)]
      : [];
  },
);

const ruleNZP028 = procedureRule(
  "NZP028",
  "VARRAY Assignment Without EXTEND",
  "VARRAY elements should be initialized with EXTEND before assignment",
  1,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const body = maskSql(procedure.body);
    return findMatches(procedure.body, /\b([a-z_][a-z0-9_]*)\s+VARRAY\b/gi).flatMap((declaration) => {
      const name = declaration[1];
      if (!new RegExp("\\b" + name + "\\s*\\(\\s*[a-z0-9_]+\\s*\\)\\s*:=", "i").test(body)
        || new RegExp("\\b" + name + "\\.EXTEND", "i").test(body)) return [];
      return [procedureIssue("NZP028", "VARRAY '" + name + "' assigned without EXTEND. Initialize with .EXTEND() first.", 1, procedure.startOffset + declaration.index, procedure.startOffset + declaration.index + declaration[0].length)];
    });
  },
);

const ruleNZP029 = procedureRule(
  "NZP029",
  "Deep Exception Nesting",
  "Avoid deeply nested exception blocks - consider refactoring",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    let depth = 0;
    let maximum = 0;
    for (const match of findMatches(procedure.body, /\bBEGIN\b|\bEND\b/gi)) {
      if (/^BEGIN$/i.test(match[0])) {
        depth += 1;
        maximum = Math.max(maximum, depth);
      } else if (depth > 0 && !/^END\s+(IF|LOOP|CASE|_PROC)\b/i.test(procedure.body.slice(match.index))) {
        depth -= 1;
      }
    }
    return maximum > 3
      ? [procedureIssue("NZP029", "Deep exception nesting detected (" + maximum + " levels). Consider refactoring into separate procedures.", 2, procedure.startOffset, procedure.startOffset + 20)]
      : [];
  },
);

const ruleNZP030 = procedureRule(
  "NZP030",
  "Use Named Exceptions",
  "Use named exceptions instead of SQLSTATE codes",
  2,
  (sql) => {
    const procedure = procedureBodyOrEmpty(sql);
    if (!procedure) return [];
    const names: Record<string, string> = {
      "02000": "NO_DATA_FOUND",
      "23505": "UNIQUE_VIOLATION",
      "23503": "FOREIGN_KEY_VIOLATION",
      "42P01": "UNDEFINED_TABLE",
    };
    return findMatches(procedure.body, /\bWHEN\s+SQLSTATE\s+'([0-9A-Z]{5})'/gi).flatMap((match) => {
      const named = names[match[1].toUpperCase()];
      return named
        ? [procedureIssue("NZP030", "Use named exception " + named + " instead of SQLSTATE '" + match[1] + "'", 2, procedure.startOffset + match.index, procedure.startOffset + match.index + match[0].length)]
        : [];
    });
  },
);

export const netezzaProcedureQualityRules: readonly DatabaseSqlQualityRule[] = [
  ruleNZP001, ruleNZP002, ruleNZP003, ruleNZP004, ruleNZP005, ruleNZP006,
  ruleNZP007, ruleNZP008, ruleNZP009, ruleNZP010, ruleNZP011, ruleNZP012,
  ruleNZP013, ruleNZP014, ruleNZP015, ruleNZP016, ruleNZP017, ruleNZP018,
  ruleNZP019, ruleNZP020, ruleNZP022, ruleNZP023, ruleNZP024, ruleNZP025,
  ruleNZP026, ruleNZP027, ruleNZP028, ruleNZP029, ruleNZP030,
];
