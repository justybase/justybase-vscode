import type { DatabaseSqlLintIssue, DatabaseSqlQualityRule } from '@justybase/contracts';
import { findPatternMatches } from './sourceScan';

export const LintSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export type LintSeverity = (typeof LintSeverity)[keyof typeof LintSeverity];
export type LintIssue = DatabaseSqlLintIssue;
export type LintRule = DatabaseSqlQualityRule;

export { findPatternMatches };
