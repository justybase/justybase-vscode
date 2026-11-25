import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import { buildExplainRequest, normalizeExplainOutputForDisplay } from '../../../core/explain/explainRequest';
import { runExplainRequest } from '../../../core/explain/runExplain';
import type { ExplainRequest } from '../../../core/explain/explainRequest';
import {
    analyzeExplainPlanSemantic,
    collectExplainHotspotNextActions
} from '../../tuning/explainPlanSemanticAnalyzer';
import { buildSafeExplainSql } from '../../copilotTools/aiSqlSafety';
import { CopilotToolRuntime } from './copilotToolRuntime';

interface CopilotExplainTuningToolsDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    runtime: CopilotToolRuntime;
}

export class CopilotExplainTuningTools {
    constructor(private readonly deps: CopilotExplainTuningToolsDeps) { }

    /** EXPLAIN statement the active dialect will actually run. */
    buildExplainRequest(sql: string, verbose: boolean): ExplainRequest {
        const activeConn = this.deps.connectionManager.getActiveConnectionName();
        const databaseKind = this.deps.connectionManager.getConnectionDatabaseKind(activeConn ?? undefined);
        return buildExplainRequest(sql, databaseKind, { verbose });
    }

    async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        const activeConn = this.deps.connectionManager.getActiveConnectionName();
        if (!activeConn) throw new Error('No active connection');

        // `buildSafeExplainSql` only validates the statement; the dialect decides
        // the real EXPLAIN syntax (`EXPLAIN PLAN FOR` on Db2, `FORMAT=JSON` on
        // MySQL, and so on).
        buildSafeExplainSql(sql, verbose);
        const databaseKind = this.deps.connectionManager.getConnectionDatabaseKind(activeConn);
        const request = buildExplainRequest(sql, databaseKind, { verbose });

        const scopedDatabase = this.deps.runtime.normalizeScopeDatabase(database);
        const rawPlan = scopedDatabase
            ? await this.deps.runtime.runExplainInDatabaseScope(request, scopedDatabase)
            : await runExplainRequest(
                this.deps.context,
                this.deps.connectionManager,
                activeConn,
                undefined,
                request,
            );

        // Persisted-plan dialects return JSON rows; the semantic analyzer and
        // every caller expect the shared plan-text shape.
        const plan = rawPlan ? normalizeExplainOutputForDisplay(rawPlan, databaseKind) : rawPlan;
        return plan || 'No execution plan returned';
    }

    async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        const normalizedSql = sql.trim();
        const databaseKind = this.deps.connectionManager.getConnectionDatabaseKind(
            this.deps.connectionManager.getActiveConnectionName() ?? undefined,
        );
        const explainSql = buildExplainRequest(normalizedSql, databaseKind, { verbose }).explainSql;
        const plan = await this.getExplainPlan(normalizedSql, verbose, database);
        const analysis = analyzeExplainPlanSemantic(plan);

        const parseWarning =
            analysis.summary.parseCoverage.totalLines > 0 && analysis.summary.parseCoverage.matchedLines === 0
                ? 'EXPLAIN returned output, but no semantic nodes could be parsed.'
                : undefined;
        const nextActions = collectExplainHotspotNextActions(analysis.hotspots);

        return this.deps.runtime.formatStructuredToolResponse({
            summary:
                `EXPLAIN semantic analysis completed: ${analysis.summary.nodeCount} node(s), ` +
                `${analysis.hotspots.length} hotspot(s), risk ${analysis.summary.overallRisk}.`,
            data: {
                databaseScope: this.deps.runtime.normalizeScopeDatabase(database) || 'active connection database',
                explainSql,
                verbose,
                summary: analysis.summary,
                graph: {
                    nodes: analysis.nodes,
                    edges: analysis.edges
                },
                hotspots: analysis.hotspots,
                rawPlan: plan
            },
            errors: parseWarning ? [parseWarning] : undefined,
            nextActions: nextActions.length > 0
                ? nextActions
                : ['Review highest-cost operator and re-run EXPLAIN VERBOSE after each change.']
        });
    }

}
