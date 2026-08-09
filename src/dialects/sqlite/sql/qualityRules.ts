import { LintSeverity, findPatternMatches, type LintIssue, type LintRule } from '../../../providers/linterRules';
import {
    createDeleteFromPattern,
    createDeleteWithoutWhereRule,
    createIdentifierPattern,
    createSelectStarRule,
    createStatementEndScanner,
    createUpdateSetPattern,
    createUpdateWithoutWhereRule,
} from '../../../providers/qualityRuleFactory';

const statementEnd = createStatementEndScanner();
const identifier = createIdentifierPattern();

const ruleSLT001 = createSelectStarRule({
    id: 'SLT001',
    name: 'Select Star',
    description: 'Avoid SELECT * when a stable projection is possible.',
    defaultSeverity: LintSeverity.Warning,
    selectStarPattern: /\bSELECT\s+\*/gi,
});

const ruleSLT002 = createDeleteWithoutWhereRule({
    id: 'SLT002',
    name: 'Delete Without Where',
    description: 'DELETE without WHERE removes every row in the target SQLite table.',
    defaultSeverity: LintSeverity.Error,
    statementEnd,
    targetPattern: createDeleteFromPattern(identifier),
});

const ruleSLT003 = createUpdateWithoutWhereRule({
    id: 'SLT003',
    name: 'Update Without Where',
    description: 'UPDATE without WHERE changes every row in the target SQLite table.',
    defaultSeverity: LintSeverity.Error,
    statementEnd,
    targetPattern: createUpdateSetPattern(identifier),
});

const ruleSLT004: LintRule = {
    id: 'SLT004',
    name: 'Foreign Keys Disabled',
    description: 'PRAGMA foreign_keys=OFF disables SQLite foreign-key enforcement for the connection.',
    defaultSeverity: LintSeverity.Warning,
    check(sql: string): LintIssue[] {
        return findPatternMatches(sql, /\bPRAGMA\s+(?:[A-Za-z_][\w$]*\s*\.\s*)?foreign_keys\s*=\s*(?:OFF|0)\b/gi)
            .map(match => ({
                ruleId: 'SLT004',
                message: 'SLT004: PRAGMA foreign_keys=OFF disables foreign-key enforcement.',
                severity: LintSeverity.Warning,
                startOffset: match.index,
                endOffset: match.index + match[0].length,
            }));
    },
};

export const sqliteSqlQualityRules: readonly LintRule[] = [
    ruleSLT001,
    ruleSLT002,
    ruleSLT003,
    ruleSLT004,
];
