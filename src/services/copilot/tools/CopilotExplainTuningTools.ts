import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import { runExplainQuery } from '../../../core/queryRunner';
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

    async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        const activeConn = this.deps.connectionManager.getActiveConnectionName();
        if (!activeConn) throw new Error('No active connection');

        const explainSql = buildSafeExplainSql(sql, verbose);

        const scopedDatabase = this.deps.runtime.normalizeScopeDatabase(database);
        const plan = scopedDatabase
            ? await this.deps.runtime.runExplainInDatabaseScope(explainSql, scopedDatabase)
            : await runExplainQuery(this.deps.context, explainSql, activeConn, this.deps.connectionManager, undefined);
        return plan || 'No execution plan returned';
    }

    async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        const normalizedSql = sql.trim();
        const explainSql = buildSafeExplainSql(normalizedSql, verbose);
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
