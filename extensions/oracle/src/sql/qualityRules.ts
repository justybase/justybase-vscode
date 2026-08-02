import { LintSeverity, type LintRule } from '../../../../src/providers/linterRules';
import {
    createDeleteFromPattern,
    createDeleteWithoutWhereRule,
    createIdentifierPattern,
    createRownumWithOrderByRule,
    createSelectStarRule,
    createStatementEndScanner,
    createUpdateSetPattern,
    createUpdateWithoutWhereRule,
} from '../../../../src/providers/qualityRuleFactory';

const statementEnd = createStatementEndScanner({ oracleQQuote: true });
const identifier = createIdentifierPattern();

export const ruleORA001: LintRule = createSelectStarRule({
    id: 'ORA001',
    name: 'Select Star',
    description:
        'Avoid SELECT * in production Oracle queries when a stable projection is possible.',
    defaultSeverity: LintSeverity.Warning,
    selectStarPattern: /\bSELECT\s+\*/gi,
});

export const ruleORA002: LintRule = createDeleteWithoutWhereRule({
    id: 'ORA002',
    name: 'Delete Without Where',
    description: 'DELETE without WHERE removes every row in the target table.',
    defaultSeverity: LintSeverity.Error,
    statementEnd,
    targetPattern: createDeleteFromPattern(identifier),
});

export const ruleORA003: LintRule = createUpdateWithoutWhereRule({
    id: 'ORA003',
    name: 'Update Without Where',
    description: 'UPDATE without WHERE changes every row in the target table.',
    defaultSeverity: LintSeverity.Error,
    statementEnd,
    targetPattern: createUpdateSetPattern(identifier),
});

export const ruleORA004: LintRule = createRownumWithOrderByRule({
    id: 'ORA004',
    name: 'Rownum With Order By',
    description:
        'ROWNUM is evaluated before a same-level ORDER BY; use an ordered subquery or FETCH FIRST for deterministic top-N results.',
    defaultSeverity: LintSeverity.Warning,
    statementEnd,
});

export const oracleSqlQualityRules: readonly LintRule[] = [
    ruleORA001,
    ruleORA002,
    ruleORA003,
    ruleORA004,
];
