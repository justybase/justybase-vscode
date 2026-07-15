import * as vscode from 'vscode';
import { createSqlValidatorForDocument, getSqlAuthoringForDocument } from '../../../commands/validationCommands';
import { LintIssue } from '../../../providers/linterRules';
import { analyzeExplainPlanSemantic, collectExplainHotspotNextActions } from '../../tuning/explainPlanSemanticAnalyzer';
import { CopilotToolRuntime } from './copilotToolRuntime';
import { buildSafeExplainSql } from '../../copilotTools/aiSqlSafety';

interface AntiPatternFixProfile {
    rationale: string;
    rewriteOptions: string[];
    tradeOffs: string;
    confidence: number;
}

interface RankedAntiPatternFixCandidate extends AntiPatternFixProfile {
    ruleId: string;
    severity: vscode.DiagnosticSeverity;
    occurrences: number;
}

const DEFAULT_SQL_ANTI_PATTERN_PROFILE: AntiPatternFixProfile = {
    rationale: 'This pattern can increase SPU data movement, reduce zone-map pruning, and raise full-scan I/O cost in Netezza.',
    rewriteOptions: [
        'Prefer explicit predicates and narrower column projection.',
        'Align join/filter columns with distribution strategy when possible.',
        'Re-run EXPLAIN to verify lower scan and redistribution cost.'
    ],
    tradeOffs: 'More explicit SQL usually improves plan stability but can require extra maintenance when schema evolves.',
    confidence: 0.68
};

const DEFAULT_PROCEDURE_ANTI_PATTERN_PROFILE: AntiPatternFixProfile = {
    rationale: 'Procedure anti-patterns can amplify row-by-row work, transaction overhead, and SPU synchronization in Netezza.',
    rewriteOptions: [
        'Prefer set-based SQL inside procedures and reduce loop-driven row processing.',
        'Keep transaction/control-flow blocks explicit and minimal.',
        'Validate procedure blocks with parser/linter before deployment.'
    ],
    tradeOffs: 'Set-based rewrites are faster at runtime but can make procedural intent less explicit for small scripts.',
    confidence: 0.66
};

const RULE_SPECIFIC_ANTI_PATTERN_PROFILES: Record<string, AntiPatternFixProfile> = {
    NZ001: {
        rationale: 'SELECT * often disables efficient projection, increasing SPU I/O and weakening zone-map benefits on wide tables.',
        rewriteOptions: [
            'Replace SELECT * with only required business columns.',
            'Keep join/filter keys first in projection for readability and review.',
            'Create a stable view with curated columns for repeated reporting use.'
        ],
        tradeOffs: 'Column-level projection cuts I/O but requires query updates when selected columns change.',
        confidence: 0.81
    },
    NZ002: {
        rationale: 'DELETE without a WHERE can trigger full-table data rewrite across SPUs and accidental mass data loss.',
        rewriteOptions: [
            'Add a selective WHERE predicate keyed by business or technical identifier.',
            'Stage candidate rows in a temp table, validate count, then delete via join.',
            'Wrap destructive deletes in an explicit transaction with pre/post row-count checks.'
        ],
        tradeOffs: 'Safer deletes add extra verification steps but significantly reduce blast radius.',
        confidence: 0.95
    },
    NZ003: {
        rationale: 'UPDATE without a WHERE can rewrite entire table slices, causing heavy SPU work and lock contention.',
        rewriteOptions: [
            'Add a WHERE predicate that targets only intended rows.',
            'Use MERGE against staged delta data for deterministic updates.',
            'Split large updates into batches if operational windows are tight.'
        ],
        tradeOffs: 'Targeted updates are safer and faster, but batching/merge flows add orchestration complexity.',
        confidence: 0.94
    },
    NZ004: {
        rationale: 'CROSS JOIN can explode row counts, forcing high redistribution between SPUs and expensive downstream operators.',
        rewriteOptions: [
            'Replace CROSS JOIN with explicit INNER/LEFT JOIN predicates when relation exists.',
            'Pre-aggregate one side before joining to reduce row explosion.',
            'If Cartesian logic is intentional, add tight filters before join execution.'
        ],
        tradeOffs: 'Adding join constraints improves performance but must preserve intended business cardinality.',
        confidence: 0.88
    },
    NZP001: {
        rationale: 'Missing BEGIN_PROC/END_PROC weakens procedure boundaries and can cause runtime parser/transaction ambiguity.',
        rewriteOptions: [
            'Wrap procedure body with explicit BEGIN_PROC ... END_PROC delimiters.',
            'Keep transactional and error-handling sections inside clearly scoped blocks.'
        ],
        tradeOffs: 'Stricter block structure improves reliability but requires consistent team conventions.',
        confidence: 0.84
    },
    NZP002: {
        rationale: 'Missing LANGUAGE clause prevents deterministic procedure compilation and execution behavior.',
        rewriteOptions: [
            'Add explicit LANGUAGE NZPLSQL (or the required supported language).',
            'Match procedure syntax and control structures to the declared language.'
        ],
        tradeOffs: 'Explicit language declarations improve portability and supportability with minimal downside.',
        confidence: 0.9
    },
    NZP003: {
        rationale: 'Missing RETURNS clause makes procedure output contracts ambiguous and can break orchestration expectations.',
        rewriteOptions: [
            'Add explicit RETURNS type aligned with actual procedure output behavior.',
            'Use RETURNS TABLE(...) for tabular outputs and scalar type for single-value flows.',
            'Keep return contract stable to avoid downstream ETL/report breakage.'
        ],
        tradeOffs: 'Explicit return contracts improve reliability and integration safety but require updates when output shape changes.',
        confidence: 0.87
    },
    NZP004: {
        rationale: 'Unmatched BEGIN/END blocks increase procedural control-flow risk and can cause hidden runtime failures.',
        rewriteOptions: [
            'Balance all BEGIN/END blocks and keep nesting shallow.',
            'Extract deeply nested logic into helper procedures where possible.'
        ],
        tradeOffs: 'Refactoring nested logic improves safety but may require additional interface parameters between procedures.',
        confidence: 0.89
    }
};


export class CopilotValidationTools {
    constructor(private readonly deps: {
        runtime: CopilotToolRuntime;
        getExplainPlan: (sql: string, verbose: boolean, database?: string) => Promise<string>;
    }) { }

    private getSeverityWeight(severity: vscode.DiagnosticSeverity): number {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return 4;
            case vscode.DiagnosticSeverity.Warning:
                return 3;
            case vscode.DiagnosticSeverity.Information:
                return 2;
            case vscode.DiagnosticSeverity.Hint:
                return 1;
            default:
                return 0;
        }
    }

    private getAntiPatternFixProfile(ruleId: string): AntiPatternFixProfile {
        const normalizedRuleId = ruleId.toUpperCase();
        const specificProfile = RULE_SPECIFIC_ANTI_PATTERN_PROFILES[normalizedRuleId];
        if (specificProfile) {
            return specificProfile;
        }

        if (normalizedRuleId.startsWith('NZP')) {
            return DEFAULT_PROCEDURE_ANTI_PATTERN_PROFILE;
        }

        return DEFAULT_SQL_ANTI_PATTERN_PROFILE;
    }

    private clampConfidence(value: number): number {
        return Math.max(0.5, Math.min(0.99, value));
    }

    private buildRankedAntiPatternFixCandidates(issues: LintIssue[]): RankedAntiPatternFixCandidate[] {
        const grouped = new Map<string, { severity: vscode.DiagnosticSeverity; occurrences: number }>();

        for (const issue of issues) {
            const ruleId = issue.ruleId.toUpperCase();
            if (!/^NZ(?:P)?\d+$/i.test(ruleId)) {
                continue;
            }

            const existing = grouped.get(ruleId);
            if (existing) {
                existing.occurrences += 1;
                if (this.getSeverityWeight(issue.severity) > this.getSeverityWeight(existing.severity)) {
                    existing.severity = issue.severity;
                }
            } else {
                grouped.set(ruleId, {
                    severity: issue.severity,
                    occurrences: 1
                });
            }
        }

        const candidates: RankedAntiPatternFixCandidate[] = [];
        for (const [ruleId, aggregate] of grouped.entries()) {
            const profile = this.getAntiPatternFixProfile(ruleId);
            const severityBonus = this.getSeverityWeight(aggregate.severity) * 0.02;
            const occurrenceBonus = Math.min(aggregate.occurrences - 1, 3) * 0.03;
            candidates.push({
                ...profile,
                ruleId,
                severity: aggregate.severity,
                occurrences: aggregate.occurrences,
                confidence: this.clampConfidence(profile.confidence + severityBonus + occurrenceBonus)
            });
        }

        return candidates.sort((left, right) => {
            const severityDelta = this.getSeverityWeight(right.severity) - this.getSeverityWeight(left.severity);
            if (severityDelta !== 0) {
                return severityDelta;
            }

            if (right.confidence !== left.confidence) {
                return right.confidence - left.confidence;
            }

            if (right.occurrences !== left.occurrences) {
                return right.occurrences - left.occurrences;
            }

            return left.ruleId.localeCompare(right.ruleId);
        });
    }

    async validateSqlParser(sql: string): Promise<string> {
        const validator = createSqlValidatorForDocument();
        const { SqlQualityEngine } = await import('../../../providers/sqlQualityEngine');
        const qualityEngine = new SqlQualityEngine(validator, getSqlAuthoringForDocument().qualityRules);
        const qualityResult = qualityEngine.analyze(sql);
        const issues = qualityResult.issues;

        if (issues.length === 0) {
            return 'SQL parser validation passed. No syntax, semantic, or lint issues found.';
        }

        const maxIssues = 20;
        const lines: string[] = [
            `SQL parser validation found ${qualityResult.parserResult.errors.length} error(s) and ${qualityResult.parserResult.warnings.length} warning(s); unified quality checks found ${issues.length} issue(s):`
        ];

        for (const issue of issues.slice(0, maxIssues)) {
            const severity = this.deps.runtime.getDiagnosticSeverityLabel(issue.severity);
            const position = this.deps.runtime.getLineColumnFromOffset(sql, issue.startOffset);
            lines.push(
                `- ${issue.ruleId} [${severity}] L${position.line}:C${position.column} - ${issue.message}`
            );
        }

        if (issues.length > maxIssues) {
            lines.push(`- ... ${issues.length - maxIssues} more issue(s)`);
        }

        const rankedFixCandidates = this.buildRankedAntiPatternFixCandidates(issues);
        if (rankedFixCandidates.length > 0) {
            const maxCandidates = 8;
            lines.push('');
            lines.push('Netezza anti-pattern explainer (ranked fix candidates):');

            for (const candidate of rankedFixCandidates.slice(0, maxCandidates)) {
                const severity = this.deps.runtime.getDiagnosticSeverityLabel(candidate.severity);
                lines.push(
                    `- ${candidate.ruleId} [${severity}] confidence=${candidate.confidence.toFixed(2)} occurrences=${candidate.occurrences}`
                );
                lines.push(`  Why it matters in Netezza: ${candidate.rationale}`);
                lines.push('  Rewrite options:');
                for (const [index, option] of candidate.rewriteOptions.slice(0, 3).entries()) {
                    lines.push(`   ${index + 1}. ${option}`);
                }
                lines.push(`  Trade-offs: ${candidate.tradeOffs}`);
            }

            if (rankedFixCandidates.length > maxCandidates) {
                lines.push(`- ... ${rankedFixCandidates.length - maxCandidates} more anti-pattern candidate(s)`);
            }
        }

        return lines.join('\n');
    }

    async validateSqlOnDatabase(sql: string, database?: string): Promise<string> {
        const statementSql = sql.trim();
        if (!statementSql) {
            return this.deps.runtime.formatStructuredToolResponse({
                summary: 'Database validation could not start because SQL input is empty.',
                errors: ['No SQL statement detected for EXPLAIN dry-run validation.'],
                nextActions: ['Provide a SQL statement and retry validation.']
            });
        }

        let explainSql: string;
        try {
            explainSql = buildSafeExplainSql(statementSql, true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.deps.runtime.formatStructuredToolResponse({
                summary: 'Database validation accepts only a planner-safe SELECT statement.',
                errors: [message],
                nextActions: ['Provide exactly one SELECT or WITH ... SELECT statement without EXPLAIN.']
            });
        }
        const statementWarnings: string[] = [];
        const statementType = this.getStatementType(statementSql);

        try {
            const planText = await this.deps.getExplainPlan(statementSql, true, database);
            const analysis = analyzeExplainPlanSemantic(planText);
            const parseWarning =
                analysis.summary.parseCoverage.totalLines > 0 && analysis.summary.parseCoverage.matchedLines === 0
                    ? 'EXPLAIN returned output but semantic node parsing yielded zero nodes.'
                    : undefined;
            const errors = [
                ...statementWarnings,
                ...(parseWarning ? [parseWarning] : [])
            ];
            const nextActions = collectExplainHotspotNextActions(analysis.hotspots);

            return this.deps.runtime.formatStructuredToolResponse({
                summary:
                    `Database validation succeeded via EXPLAIN dry-run for ${statementType} statement. ` +
                    `Parsed ${analysis.summary.nodeCount} plan node(s); detected ${analysis.hotspots.length} hotspot(s) ` +
                    `(risk: ${analysis.summary.overallRisk}).`,
                data: {
                    databaseScope: this.deps.runtime.normalizeScopeDatabase(database) || 'active connection database',
                    statementType,
                    statementCount: 1,
                    validatedStatement: statementSql,
                    explainSql,
                    semanticSummary: analysis.summary,
                    hotspots: analysis.hotspots,
                    graph: {
                        nodes: analysis.nodes,
                        edges: analysis.edges
                    },
                    rawPlan: planText
                },
                errors: errors.length > 0 ? errors : undefined,
                nextActions: nextActions.length > 0
                    ? nextActions
                    : ['Validation passed with no obvious EXPLAIN hotspots. Re-run after query changes.']
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return this.deps.runtime.formatStructuredToolResponse({
                summary: `Database validation failed for ${statementType} statement.`,
                data: {
                    databaseScope: this.deps.runtime.normalizeScopeDatabase(database) || 'active connection database',
                    statementType,
                    statementCount: 1,
                    validatedStatement: statementSql,
                    explainSql
                },
                errors: [...statementWarnings, message],
                nextActions: [
                    'Verify SQL compiles with parser validation (#validateSqlParser).',
                    'Check connection/database scope and table/object references.',
                    'Retry EXPLAIN after fixing the reported database error.'
                ]
            });
        }
    }

    private getStatementType(sql: string): string {
        const match = sql.trim().match(/^([A-Z]+)/i);
        if (!match) {
            return 'UNKNOWN';
        }
        return match[1].toUpperCase();
    }

    async validateSql(sql: string): Promise<string> {
        // Backward-compatible alias for parser validation.
        return this.validateSqlParser(sql);
    }

    async getSqlDiagnostics(includeWarnings: boolean = true): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'sql') {
            return 'No active SQL editor. Open a SQL document to inspect diagnostics.';
        }

        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
        const relevantDiagnostics = diagnostics.filter(diagnostic => {
            if (!includeWarnings && diagnostic.severity !== vscode.DiagnosticSeverity.Error) {
                return false;
            }

            const code = typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? '');
            const hasSqlCode = /^(SQL|PAR|LEX|PARW|NZ|NZP)\d+$/i.test(code);
            return (
                hasSqlCode ||
                diagnostic.source === 'Netezza Quality' ||
                diagnostic.source === 'SQL LSP'
            );
        });

        if (relevantDiagnostics.length === 0) {
            return 'No SQL diagnostics found for the active document.';
        }

        const lines: string[] = [
            `SQL diagnostics for ${editor.document.uri.fsPath}:`,
            `Total issues: ${relevantDiagnostics.length}`
        ];

        for (const diagnostic of relevantDiagnostics) {
            const code = typeof diagnostic.code === 'string' ? diagnostic.code : String(diagnostic.code ?? 'N/A');
            const severity = this.deps.runtime.getDiagnosticSeverityLabel(diagnostic.severity);
            const line = diagnostic.range.start.line + 1;
            const column = diagnostic.range.start.character + 1;
            lines.push(`- ${code} [${severity}] L${line}:C${column} - ${diagnostic.message}`);
        }

        return lines.join('\n');
    }

}
