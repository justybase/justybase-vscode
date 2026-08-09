import { LintSeverity, findPatternMatches, type LintIssue, type LintRule } from '../../../../src/providers/linterRules';
import {
  createDeleteFromPattern,
  createDeleteWithoutWhereRule,
  createIdentifierPattern,
  createSelectStarRule,
  createStatementEndScanner,
  createUpdateSetPattern,
  createUpdateWithoutWhereRule,
} from '../../../../src/providers/qualityRuleFactory';

const statementEnd = createStatementEndScanner();
const identifier = createIdentifierPattern();

export const ruleDDK001: LintRule = createSelectStarRule({
  id: 'DDK001',
  name: 'Select Star',
  description: 'Avoid SELECT * in production DuckDB queries when a stable projection is possible.',
  defaultSeverity: LintSeverity.Warning,
  selectStarPattern: /\bSELECT\s+\*/gi,
});

export const ruleDDK002: LintRule = createDeleteWithoutWhereRule({
  id: 'DDK002',
  name: 'Delete Without Where',
  description: 'DELETE without WHERE removes every row in the target DuckDB table.',
  defaultSeverity: LintSeverity.Error,
  statementEnd,
  targetPattern: createDeleteFromPattern(identifier),
});

export const ruleDDK003: LintRule = createUpdateWithoutWhereRule({
  id: 'DDK003',
  name: 'Update Without Where',
  description: 'UPDATE without WHERE changes every row in the target DuckDB table.',
  defaultSeverity: LintSeverity.Error,
  statementEnd,
  targetPattern: createUpdateSetPattern(identifier),
});

function createFileReadOnlyDmlRule(): LintRule {
  const dmlPattern = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"[^"]+"|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*)){0,2}/gi;

  return {
    id: 'FSL001',
    name: 'File SQL Read Only Source',
    description: 'File SQL sources are read-only; write to the generated _edit table when edits are enabled.',
    defaultSeverity: LintSeverity.Warning,
    check(sql): LintIssue[] {
      return findPatternMatches(sql, dmlPattern)
        .filter((match) => !/_edit\b/i.test(match[0]))
        .map((match) => ({
          ruleId: 'FSL001',
          message: 'FSL001: File SQL sources are read-only; use an _edit table for DML.',
          severity: LintSeverity.Warning,
          startOffset: match.index,
          endOffset: match.index + match[0].length,
        }));
    },
  };
}

export const ruleFSL001 = createFileReadOnlyDmlRule();

export const duckdbSqlQualityRules: readonly LintRule[] = [
  ruleDDK001,
  ruleDDK002,
  ruleDDK003,
];

export const fileSqlQualityRules: readonly LintRule[] = [
  ruleDDK001,
  ruleDDK002,
  ruleDDK003,
  ruleFSL001,
];
