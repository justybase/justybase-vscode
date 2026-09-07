import {
    netezzaProcedureQualityRules as coreProcedureQualityRules,
    netezzaSqlQualityRules as coreSqlQualityRules,
} from '@justybase/sql-core';
import type { DatabaseSqlQualityRule } from '@justybase/contracts';
import type { LintIssue, LintRule } from '../../../providers/linterRules';

/**
 * Desktop compatibility view of the canonical Netezza quality rules.
 * Diagnostics are produced by the package-owned rule functions; this adapter
 * only preserves the historic desktop LintRule shape for authoring packs.
 */
function toDesktopRule(rule: DatabaseSqlQualityRule): LintRule {
    return {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        defaultSeverity: rule.defaultSeverity,
        onDemandOnly: rule.onDemandOnly,
        check(sql: string): LintIssue[] {
            return rule.check(sql).map((issue) => ({
                ruleId: issue.ruleId,
                message: issue.message,
                severity: issue.severity,
                startOffset: issue.startOffset,
                endOffset: issue.endOffset,
                suggestedFix: issue.suggestedFix,
            }));
        },
    };
}

export const netezzaSqlQualityRules: readonly LintRule[] = [
    ...coreSqlQualityRules,
    ...coreProcedureQualityRules,
].map(toDesktopRule);
