import * as linterRulesModule from '../../../providers/linterRules';
import * as procedureRulesModule from '../../../providers/procedureRules';
import { isParserOwnedQualityRule } from '../../../providers/qualityRuleRegistry';
import type { LintIssue, LintRule } from '../../../providers/linterRules';

function isLintIssue(value: unknown): value is LintIssue {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate = value as Partial<LintIssue>;
    return (
        typeof candidate.ruleId === 'string' &&
        typeof candidate.message === 'string' &&
        typeof candidate.severity === 'number' &&
        typeof candidate.startOffset === 'number' &&
        typeof candidate.endOffset === 'number'
    );
}

function isLintRule(value: unknown): value is LintRule {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate = value as Partial<LintRule>;
    if (!(
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.description === 'string' &&
        typeof candidate.check === 'function'
    )) {
        return false;
    }

    try {
        const probeResult = candidate.check('');
        return Array.isArray(probeResult) && probeResult.every(issue => isLintIssue(issue));
    } catch {
        return false;
    }
}

function collectRulesByExportPrefix(moduleExports: Record<string, unknown>, exportPrefix: string): LintRule[] {
    const collectedRules: LintRule[] = [];

    for (const [exportName, exportedValue] of Object.entries(moduleExports)) {
        if (exportName.startsWith(exportPrefix) && isLintRule(exportedValue)) {
            collectedRules.push(exportedValue);
        }
    }

    return collectedRules.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
}

export const netezzaSqlQualityRules: readonly LintRule[] = [
    ...collectRulesByExportPrefix(linterRulesModule as Record<string, unknown>, 'ruleNZ')
        .filter((rule) => !isParserOwnedQualityRule(rule.id)),
    ...collectRulesByExportPrefix(procedureRulesModule as Record<string, unknown>, 'ruleNZP')
];
