import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { getDatabaseDialect, getRequiredDatabaseDdlProvider, getRequiredDatabaseTuningAdvisor } from '../../core/connectionFactory';
import { runExplainQuery, runQueryRaw, queryResultToRows } from '../../core/queryRunner';
import { assertExecutionCurrent, type ExecutionCurrentCheck } from '../../core/executionGuard';
import { SqlParser } from '../../sql/sqlParser';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import type { TuningReport, TuningRecommendation } from '../../services/tuning/types';
import { TableReferenceExtractor } from '../../services/copilot/TableReferenceExtractor';
import type { TableReference } from '../../services/copilot/types';
import { ResultPanelView } from '../../views/resultPanelView';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../../compatibility/state';
import { tryAcquireQueryExecution } from './queryExecutionGate';
import { createQueryExecutionRecovery } from './queryExecutionRecovery';

interface QueryRow {
    [key: string]: unknown;
}

interface TuningTableTarget {
    database: string;
    schema?: string;
    table: string;
}

interface TuningTableStatsResult {
    tableStatsText: string;
    tableName?: string;
    diagnostics: string[];
}

type TuningFeedbackKind = 'helpful' | 'not_helpful' | 'dismissed';

interface TuningAdvisorFeedbackState {
    helpfulCount: number;
    notHelpfulCount: number;
    dismissedCount: number;
    lastUpdatedAt: string;
}

interface TuningAdvisorSuccessContext {
    recommendationCount: number;
    hasExplainOutput: boolean;
    hasTableStats: boolean;
}

const TUNING_FEEDBACK_HELPFUL_LABEL = 'Helpful';
const TUNING_FEEDBACK_NOT_HELPFUL_LABEL = 'Not Helpful';

export function toPerfErrorCode(message: string): string {
    const normalized = message
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) {
        return 'QUERY_ERROR';
    }
    return normalized.slice(0, 64);
}

function getCaseInsensitiveValue(row: QueryRow, key: string): unknown {
    if (key in row) {
        return row[key];
    }

    const lower = key.toLowerCase();
    const match = Object.keys(row).find((candidate) => candidate.toLowerCase() === lower);
    if (!match) {
        return undefined;
    }
    return row[match];
}

function toStringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    return String(value);
}

function toUpperStringValue(value: unknown): string | undefined {
    const str = toStringValue(value);
    if (!str) {
        return undefined;
    }
    return str.trim().toUpperCase();
}

function toNumberValue(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    const normalized = String(value).replace(/,/g, '').trim();
    if (!normalized) {
        return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function stripExplainPrefix(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed.toUpperCase().startsWith('EXPLAIN')) {
        return trimmed;
    }
    return trimmed.replace(/^EXPLAIN\s+(?:(?:QUERY\s+PLAN)|VERBOSE)?\s*/i, '').trim();
}

async function buildExplainSqlForDialect(
    sql: string,
    databaseKind: string | undefined,
    options: { verbose: boolean; analyze?: boolean },
): Promise<string> {
    const strippedSql = stripExplainPrefix(sql);
    if (databaseKind === 'postgresql') {
        const { buildPostgreSqlExplainQuery } =
            await import('../../../extensions/postgresql/src/postgresqlExplainParser');
        return buildPostgreSqlExplainQuery(strippedSql, {
            analyze: options.analyze ?? false,
            verbose: options.verbose,
        });
    }

    if (databaseKind === 'mysql') {
        const { buildMysqlExplainQuery } = await import('../../../extensions/mysql/src/mysqlExplainParser');
        return buildMysqlExplainQuery(strippedSql, {
            analyze: options.analyze ?? false,
            verbose: options.verbose,
        });
    }

    if (databaseKind === 'snowflake') {
        const { buildSnowflakeExplainQuery } = await import('../../../extensions/snowflake/src/snowflakeQueryProfile');
        return buildSnowflakeExplainQuery(strippedSql);
    }

    if (databaseKind === 'sqlite') {
        return `EXPLAIN QUERY PLAN ${strippedSql}`;
    }

    return options.verbose ? `EXPLAIN VERBOSE ${strippedSql}` : `EXPLAIN ${strippedSql}`;
}

async function normalizeExplainOutputForDisplay(
    explainOutput: string,
    databaseKind: string | undefined,
): Promise<string> {
    if (databaseKind === 'postgresql') {
        const { isPostgreSqlExplainJson, parsePostgreSqlExplainJson, renderPostgreSqlExplainPlan } =
            await import('../../../extensions/postgresql/src/postgresqlExplainParser');

        if (!isPostgreSqlExplainJson(explainOutput)) {
            return explainOutput;
        }

        return renderPostgreSqlExplainPlan(parsePostgreSqlExplainJson(explainOutput));
    }

    if (databaseKind === 'mysql') {
        const { isMysqlExplainJson, isMysqlExplainText, parseMysqlExplainPlan, renderMysqlExplainPlan } =
            await import('../../../extensions/mysql/src/mysqlExplainParser');

        if (!isMysqlExplainJson(explainOutput) && !isMysqlExplainText(explainOutput)) {
            return explainOutput;
        }

        return renderMysqlExplainPlan(parseMysqlExplainPlan(explainOutput));
    }

    if (databaseKind === 'snowflake') {
        const { isSnowflakeExplainJson, parseSnowflakeExplainJson, renderSnowflakeExplainPlan } =
            await import('../../../extensions/snowflake/src/snowflakeQueryProfile');

        if (!isSnowflakeExplainJson(explainOutput)) {
            return explainOutput;
        }

        return renderSnowflakeExplainPlan(parseSnowflakeExplainJson(explainOutput));
    }

    if (databaseKind === 'sqlite') {
        const { normalizeSqliteExplainPlan } = await import('../../dialects/sqlite/explainParser');
        return normalizeSqliteExplainPlan(explainOutput);
    }

    return explainOutput;
}

function resolveTuningFeedbackKind(selection: string | undefined): TuningFeedbackKind {
    if (selection === TUNING_FEEDBACK_HELPFUL_LABEL) {
        return 'helpful';
    }
    if (selection === TUNING_FEEDBACK_NOT_HELPFUL_LABEL) {
        return 'not_helpful';
    }
    return 'dismissed';
}

function getInitialTuningFeedbackState(): TuningAdvisorFeedbackState {
    return {
        helpfulCount: 0,
        notHelpfulCount: 0,
        dismissedCount: 0,
        lastUpdatedAt: new Date().toISOString(),
    };
}

function incrementTuningFeedbackState(
    currentState: TuningAdvisorFeedbackState,
    feedback: TuningFeedbackKind,
): TuningAdvisorFeedbackState {
    const nextState: TuningAdvisorFeedbackState = {
        ...currentState,
        lastUpdatedAt: new Date().toISOString(),
    };
    if (feedback === 'helpful') {
        nextState.helpfulCount += 1;
    } else if (feedback === 'not_helpful') {
        nextState.notHelpfulCount += 1;
    } else {
        nextState.dismissedCount += 1;
    }
    return nextState;
}

async function saveTuningFeedbackState(
    context: vscode.ExtensionContext,
    feedback: TuningFeedbackKind,
): Promise<TuningAdvisorFeedbackState> {
    const currentState =
        getMementoValue<TuningAdvisorFeedbackState>(
            context.globalState,
            compatibilityStateKeys.tuningAdvisorFeedbackState,
            getInitialTuningFeedbackState(),
        ) ?? getInitialTuningFeedbackState();
    const nextState = incrementTuningFeedbackState(currentState, feedback);
    await updateMementoValue(context.globalState, compatibilityStateKeys.tuningAdvisorFeedbackState, nextState);
    return nextState;
}

async function collectTuningAdvisorFeedback(
    context: vscode.ExtensionContext,
    successContext: TuningAdvisorSuccessContext,
): Promise<void> {
    const selection = await vscode.window.showInformationMessage(
        `Tuning Advisor report generated (${successContext.recommendationCount} recommendation(s)). Was this advice useful?`,
        TUNING_FEEDBACK_HELPFUL_LABEL,
        TUNING_FEEDBACK_NOT_HELPFUL_LABEL,
    );
    const feedback = resolveTuningFeedbackKind(selection);

    try {
        const feedbackState = await saveTuningFeedbackState(context, feedback);
        const feedbackEvent = createPerformanceTimer('tuning_advice_feedback').finish({
            result: 'ok',
            metadata: {
                feedback,
                recommendation_count: successContext.recommendationCount,
                has_explain_output: successContext.hasExplainOutput,
                has_table_stats: successContext.hasTableStats,
                helpful_count: feedbackState.helpfulCount,
                not_helpful_count: feedbackState.notHelpfulCount,
                dismissed_count: feedbackState.dismissedCount,
            },
        });
        console.log(formatPerformanceEvent(feedbackEvent));
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        const feedbackErrorEvent = createPerformanceTimer('tuning_advice_feedback').finish({
            result: 'error',
            errorCode: 'FEEDBACK_PERSIST_FAILED',
            metadata: {
                feedback,
                reason: detail,
            },
        });
        console.log(formatPerformanceEvent(feedbackErrorEvent));
    }
}

async function runInternalQueryRows(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    sql: string,
    documentUri: string,
    isExecutionCurrent: ExecutionCurrentCheck,
): Promise<QueryRow[]> {
    assertExecutionCurrent(isExecutionCurrent);
    const result = await runQueryRaw({
        context,
        query: sql,
        silent: true,
        connectionManager,
        connectionName,
        documentUri,
        isUserQuery: false,
        isExecutionCurrent,
    });
    assertExecutionCurrent(isExecutionCurrent);
    return queryResultToRows<QueryRow>(result);
}

function getTuningDdlProvider(
    connectionManager: ConnectionManager,
    connectionName: string,
): ReturnType<typeof getRequiredDatabaseDdlProvider> {
    return getRequiredDatabaseDdlProvider(connectionManager.getConnectionDatabaseKind(connectionName));
}

function getTuningSqlFromEditor(editor: vscode.TextEditor): string | undefined {
    const document = editor.document;
    const selection = editor.selection;

    if (!selection.isEmpty) {
        const selectedText = document.getText(selection);
        return selectedText.trim() ? selectedText : undefined;
    }

    const fullText = document.getText();
    if (!fullText.trim()) {
        return undefined;
    }

    const offset = document.offsetAt(selection.active);
    const statement = SqlParser.getStatementAtPosition(fullText, offset);
    if (statement?.sql?.trim()) {
        const startPos = document.positionAt(statement.start);
        const endPos = document.positionAt(statement.end);
        editor.selection = new vscode.Selection(startPos, endPos);
        return statement.sql;
    }

    return fullText;
}

function getPrimaryTableReference(sql: string): TableReference | undefined {
    const extractor = new TableReferenceExtractor();
    const references = extractor.extract(sql);
    if (references.length === 0) {
        return undefined;
    }
    return references[0];
}

async function resolveTuningTableTarget(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    sql: string,
    documentUri: string,
    isExecutionCurrent: ExecutionCurrentCheck,
): Promise<{ target?: TuningTableTarget; diagnostics: string[] }> {
    assertExecutionCurrent(isExecutionCurrent);
    const diagnostics: string[] = [];
    const tableReference = getPrimaryTableReference(sql);
    if (!tableReference) {
        diagnostics.push('No table reference found in SQL. Skipping table statistics.');
        return { diagnostics };
    }

    const table = tableReference.name.toUpperCase();
    const currentDatabase = await connectionManager.getCurrentDatabase(connectionName);
    assertExecutionCurrent(isExecutionCurrent);
    const database = (tableReference.database || currentDatabase || '').toUpperCase();
    if (!database) {
        diagnostics.push(`Could not determine database for table ${table}. Skipping table statistics.`);
        return { diagnostics };
    }

    let schema = tableReference.schema?.toUpperCase();
    if (!schema) {
        try {
            const escapedTable = table.replace(/'/g, "''");
            const ddlProvider = getTuningDdlProvider(connectionManager, connectionName);
            const schemaRows = await runInternalQueryRows(
                context,
                connectionManager,
                connectionName,
                ddlProvider.buildFindTableSchemaQuery(database, escapedTable),
                documentUri,
                isExecutionCurrent,
            );
            schema = toUpperStringValue(getCaseInsensitiveValue(schemaRows[0] || {}, 'SCHEMA'));
        } catch {
            assertExecutionCurrent(isExecutionCurrent);
            diagnostics.push(`Schema lookup failed for ${database}.${table}.`);
        }
    }

    if (!schema) {
        diagnostics.push(`Schema not resolved for ${database}.${table}. Using two-dot table name for row/skew checks.`);
    }

    return {
        target: {
            database,
            schema,
            table,
        },
        diagnostics,
    };
}

async function fetchPrimaryTableStatsForTuning(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    sql: string,
    documentUri: string,
    isExecutionCurrent: ExecutionCurrentCheck,
): Promise<TuningTableStatsResult> {
    const { target, diagnostics } = await resolveTuningTableTarget(
        context,
        connectionManager,
        connectionName,
        sql,
        documentUri,
        isExecutionCurrent,
    );
    assertExecutionCurrent(isExecutionCurrent);

    if (!target) {
        return {
            tableStatsText: '',
            diagnostics,
        };
    }

    const fullTableName = target.schema
        ? `${target.database}.${target.schema}.${target.table}`
        : `${target.database}..${target.table}`;
    const ddlProvider = getTuningDdlProvider(connectionManager, connectionName);
    const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
    const supportsDistributionMetrics = getDatabaseDialect(databaseKind).capabilities.supportsDistributionMetrics;

    const lines: string[] = [`## Table Statistics: ${fullTableName}`, ''];

    try {
        const countRows = await runInternalQueryRows(
            context,
            connectionManager,
            connectionName,
            `SELECT COUNT(*) AS ROW_COUNT FROM ${fullTableName}`,
            documentUri,
            isExecutionCurrent,
        );
        const rowCount = toNumberValue(getCaseInsensitiveValue(countRows[0] || {}, 'ROW_COUNT'));
        if (rowCount !== undefined) {
            lines.push(`**Row Count:** ${Math.round(rowCount).toLocaleString()}`);
        } else {
            lines.push('**Row Count:** Unable to retrieve');
            diagnostics.push(`Row count result was empty for ${fullTableName}.`);
        }
    } catch {
        assertExecutionCurrent(isExecutionCurrent);
        lines.push('**Row Count:** Unable to retrieve');
        diagnostics.push(`Row count query failed for ${fullTableName}.`);
    }

    if (target.schema) {
        try {
            const infoRows = await runInternalQueryRows(
                context,
                connectionManager,
                connectionName,
                ddlProvider.buildTableStatsQuery(target.database, target.schema, target.table),
                documentUri,
                isExecutionCurrent,
            );
            const owner = toStringValue(getCaseInsensitiveValue(infoRows[0] || {}, 'OWNER'));

            if (supportsDistributionMetrics) {
                const distributionKeys = infoRows
                    .map((row) => toStringValue(getCaseInsensitiveValue(row, 'DIST_KEY')))
                    .filter((value): value is string => Boolean(value && value.trim().length > 0));
                lines.push(`**Distribution Key:** ${distributionKeys.length > 0 ? distributionKeys.join(', ') : 'RANDOM'}`);
            }
            lines.push(`**Owner:** ${owner || 'N/A'}`);
        } catch {
            assertExecutionCurrent(isExecutionCurrent);
            if (supportsDistributionMetrics) {
                lines.push('**Distribution Key:** Unable to retrieve');
            }
            lines.push('**Owner:** Unable to retrieve');
            diagnostics.push(`Distribution metadata query failed for ${fullTableName}.`);
        }
    } else {
        if (supportsDistributionMetrics) {
            lines.push('**Distribution Key:** Unknown (schema not resolved)');
        }
        lines.push('**Owner:** N/A');
    }

    if (!supportsDistributionMetrics) {
        lines.push('', '**Distribution metrics:** Not applicable for this database dialect.');
        return {
            tableStatsText: lines.join('\n'),
            tableName: fullTableName,
            diagnostics,
        };
    }

    lines.push('', '### Data Distribution (Skew Check)', '');
    try {
        const skewRows = await runInternalQueryRows(
            context,
            connectionManager,
            connectionName,
            ddlProvider.buildSkewCheckQuery(fullTableName),
            documentUri,
            isExecutionCurrent,
        );
        const counts = skewRows
            .map((row) => toNumberValue(getCaseInsensitiveValue(row, 'ROW_COUNT')))
            .filter((value): value is number => value !== undefined);

        if (counts.length === 0) {
            lines.push('No distribution data available.');
            diagnostics.push(`Skew query returned no rows for ${fullTableName}.`);
        } else {
            const min = Math.min(...counts);
            const max = Math.max(...counts);
            const avg = counts.reduce((sum, value) => sum + value, 0) / counts.length;
            const skewRatio = max > 0 ? ((max - min) / max) * 100 : 0;

            lines.push(`**SPU Count:** ${counts.length}`);
            lines.push(`**Min Rows/SPU:** ${Math.round(min).toLocaleString()}`);
            lines.push(`**Max Rows/SPU:** ${Math.round(max).toLocaleString()}`);
            lines.push(`**Avg Rows/SPU:** ${Math.round(avg).toLocaleString()}`);
            lines.push(`**Skew Ratio:** ${skewRatio.toFixed(1)}%`);
        }
    } catch {
        assertExecutionCurrent(isExecutionCurrent);
        lines.push('Could not retrieve distribution data.');
        diagnostics.push(`Skew query failed for ${fullTableName}.`);
    }

    return {
        tableStatsText: lines.join('\n'),
        tableName: fullTableName,
        diagnostics,
    };
}

function formatEvidenceValue(value: unknown): string {
    if (value === undefined || value === null || value === '') {
        return '';
    }
    return ` (value: ${String(value)})`;
}

function buildTuningRecommendationMarkdown(recommendation: TuningRecommendation, index: number): string {
    const evidenceLines =
        recommendation.evidence.length > 0
            ? recommendation.evidence
                  .map((item) => `- \`${item.source}\`: ${item.summary}${formatEvidenceValue(item.value)}`)
                  .join('\n')
            : '- No evidence attached.';

    const actions =
        recommendation.actions.length > 0
            ? recommendation.actions.map((action) => `- ${action}`).join('\n')
            : '- No actions provided.';

    return [
        `### ${index + 1}. [${recommendation.severity.toUpperCase()}] ${recommendation.title}`,
        '',
        `- ID: \`${recommendation.id}\``,
        `- Confidence: ${Math.round(recommendation.confidence * 100)}%`,
        `- Risk: ${recommendation.risk}`,
        '',
        recommendation.summary,
        '',
        '**Actions**',
        actions,
        '',
        '**Evidence**',
        evidenceLines,
    ].join('\n');
}

function buildTuningReportMarkdown(
    report: TuningReport,
    sql: string,
    connectionName: string,
    explainPlanText: string,
    tableStats: TuningTableStatsResult,
): string {
    const severityOrder: Record<TuningRecommendation['severity'], number> = {
        critical: 0,
        warning: 1,
        info: 2,
    };

    const sortedRecommendations = [...report.recommendations].sort(
        (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
    );

    const recommendationSections =
        sortedRecommendations.length > 0
            ? sortedRecommendations
                  .map((recommendation, index) => buildTuningRecommendationMarkdown(recommendation, index))
                  .join('\n\n')
            : 'No recommendations generated.';

    const diagnostics =
        tableStats.diagnostics.length > 0 ? tableStats.diagnostics.map((line) => `- ${line}`).join('\n') : '- None';

    return [
        '# Query Tuning Advisor Report',
        '',
        `- Generated: ${report.metadata.analyzedAt}`,
        `- Connection: ${connectionName}`,
        `- SQL length: ${report.metadata.queryLength} characters`,
        `- EXPLAIN output: ${explainPlanText.trim() ? 'available' : 'empty'}`,
        `- Table stats source: ${tableStats.tableName || 'not available'}`,
        '',
        '## Summary',
        '',
        report.summary,
        '',
        '## Recommendations',
        '',
        recommendationSections,
        '',
        '## Diagnostics',
        '',
        diagnostics,
        '',
        '## SQL',
        '',
        '```sql',
        sql.trim(),
        '```',
    ].join('\n');
}

/**
 * Execute EXPLAIN query
 */
export async function executeExplainQuery(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    resultPanelProvider: ResultPanelView,
    verbose: boolean,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;

    let text: string;
    if (!selection.isEmpty) {
        text = document.getText(selection);
    } else {
        const position = editor.selection.active;
        const offset = document.offsetAt(position);
        const fullText = document.getText();
        const stmt = SqlParser.getStatementAtPosition(fullText, offset);
        if (stmt) {
            text = fullText.substring(stmt.start, stmt.end);
        } else {
            text = document.getText();
        }
    }

    if (!text.trim()) {
        vscode.window.showWarningMessage('No SQL query to explain');
        return;
    }

    const explainTimer = createPerformanceTimer('query.explain', {
        payloadSize: text.length,
    });

    let cleanQuery = text.trim();
    if (cleanQuery.toUpperCase().startsWith('EXPLAIN')) {
        cleanQuery = cleanQuery.replace(/^EXPLAIN\s+(?:VERBOSE\s+)?/i, '');
    }

    let executionGate: Awaited<ReturnType<typeof tryAcquireQueryExecution>>;
    try {
        const documentUri = document.uri.toString();
        const connectionName = connectionManager.getConnectionForExecution(documentUri);
        const databaseKind = connectionManager.getExecutionDatabaseKind(documentUri);

        if (!connectionName) {
            vscode.window.showErrorMessage('No database connection. Please connect first.');
            return;
        }

        executionGate = await tryAcquireQueryExecution(documentUri, resultPanelProvider, {
            document,
            origin: verbose ? 'Explain Query Verbose' : 'Explain Query',
            recovery: createQueryExecutionRecovery(connectionManager, documentUri, connectionName),
        });
        if (!executionGate) {
            return;
        }

        executionGate.markRunning();
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Generating query plan...',
                cancellable: false,
            },
            async () => {
                const explainQueryText = await buildExplainSqlForDialect(cleanQuery, databaseKind, {
                    verbose,
                });
                return await runExplainQuery(
                    context,
                    explainQueryText,
                    connectionName,
                    connectionManager,
                    documentUri,
                );
            },
        );
        if (!executionGate.isCurrent()) {
            return;
        }

        if (result && result.trim()) {
            const { parseExplainOutput, ExplainPlanView } = await import('../../views/explainPlanView');
            if (!executionGate.isCurrent()) {
                return;
            }
            const normalizedExplainOutput = await normalizeExplainOutputForDisplay(result, databaseKind);
            if (!executionGate.isCurrent()) {
                return;
            }
            const parsed = parseExplainOutput(normalizedExplainOutput);
            ExplainPlanView.createOrShow(context.extensionUri, parsed, cleanQuery);
        } else {
            vscode.window.showWarningMessage('No explain output received');
        }
        const successEvent = explainTimer.finish({
            result: 'ok',
            metadata: {
                verbose,
            },
        });
        console.log(formatPerformanceEvent(successEvent));
    } catch (err: unknown) {
        if (executionGate && !executionGate.isCurrent()) {
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const errorEvent = explainTimer.finish({
            result: 'error',
            errorCode: toPerfErrorCode(msg),
            metadata: {
                verbose,
            },
        });
        console.log(formatPerformanceEvent(errorEvent));
        vscode.window.showErrorMessage(`Error generating query plan: ${msg}`);
    } finally {
        executionGate?.dispose();
    }
}

export async function executeTuningAdvisor(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    resultPanelProvider: ResultPanelView,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    if (editor.document.languageId !== 'sql' && editor.document.languageId !== 'mssql') {
        vscode.window.showWarningMessage('Query Tuning Advisor is only available for SQL files');
        return;
    }

    const sqlCandidate = getTuningSqlFromEditor(editor);
    if (!sqlCandidate || !sqlCandidate.trim()) {
        vscode.window.showWarningMessage('No SQL query selected for tuning');
        return;
    }

    const sqlStatements = SqlParser.splitStatements(sqlCandidate).filter((statement) => statement.trim().length > 0);
    const sql = sqlStatements.length > 0 ? sqlStatements[0].trim() : sqlCandidate.trim();
    if (sqlStatements.length > 1) {
        vscode.window.showWarningMessage(
            'Multiple SQL statements detected. Tuning Advisor analyzed only the first statement.',
        );
    }

    const tuningTimer = createPerformanceTimer('tuning_advice_generated', {
        payloadSize: sql.length,
    });
    let executionGate: Awaited<ReturnType<typeof tryAcquireQueryExecution>>;

    try {
        const sourceUri = editor.document.uri.toString();
        const connectionName = connectionManager.getConnectionForExecution(sourceUri);
        if (!connectionName) {
            vscode.window.showErrorMessage('No database connection. Please connect first.');
            return;
        }

        const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName);
        executionGate = await tryAcquireQueryExecution(sourceUri, resultPanelProvider, {
            document: editor.document,
            origin: 'Tuning Advisor',
            recovery: createQueryExecutionRecovery(connectionManager, sourceUri, connectionName),
        });
        if (!executionGate) {
            return;
        }
        const tuningExecutionGate = executionGate;
        const explainSql = await buildExplainSqlForDialect(sql, databaseKind, {
            verbose: true,
        });

        tuningExecutionGate.markRunning();
        const successContext = await vscode.window.withProgress<TuningAdvisorSuccessContext | undefined>(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Generating tuning advice...',
                cancellable: false,
            },
            async () => {
                const explainPlanText = await runExplainQuery(
                    context,
                    explainSql,
                    connectionName,
                    connectionManager,
                    sourceUri,
                );
                if (!tuningExecutionGate.isCurrent()) {
                    return undefined;
                }

                const tableStats = await fetchPrimaryTableStatsForTuning(
                    context,
                    connectionManager,
                    connectionName,
                    sql,
                    sourceUri,
                    () => tuningExecutionGate.isCurrent(),
                );
                if (!tuningExecutionGate.isCurrent()) {
                    return undefined;
                }

                const advisor = getRequiredDatabaseTuningAdvisor(
                    connectionManager.getConnectionDatabaseKind(connectionName),
                );
                const report = advisor.analyze({
                    sql,
                    explainPlanText,
                    tableStatsText: tableStats.tableStatsText,
                });

                const markdown = buildTuningReportMarkdown(report, sql, connectionName, explainPlanText, tableStats);
                if (!tuningExecutionGate.isCurrent()) {
                    return undefined;
                }
                const reportDocument = await vscode.workspace.openTextDocument({
                    content: markdown,
                    language: 'markdown',
                });
                if (!tuningExecutionGate.isCurrent()) {
                    return undefined;
                }
                await vscode.window.showTextDocument(reportDocument, {
                    preview: false,
                });
                if (!tuningExecutionGate.isCurrent()) {
                    return undefined;
                }

                resultPanelProvider.log(
                    sourceUri,
                    `Tuning Advisor report generated (${report.metadata.recommendationCount} recommendation(s)).`,
                );
                const successEvent = tuningTimer.finish({
                    result: 'ok',
                    metadata: {
                        recommendation_count: report.metadata.recommendationCount,
                        has_explain_output: Boolean(explainPlanText.trim()),
                        has_table_stats: Boolean(tableStats.tableStatsText.trim()),
                    },
                });
                console.log(formatPerformanceEvent(successEvent));
                return {
                    recommendationCount: report.metadata.recommendationCount,
                    hasExplainOutput: Boolean(explainPlanText.trim()),
                    hasTableStats: Boolean(tableStats.tableStatsText.trim()),
                };
            },
        );
        const executionStillCurrent = tuningExecutionGate.isCurrent();
        tuningExecutionGate.dispose();
        if (!executionStillCurrent || !successContext) {
            return;
        }
        await collectTuningAdvisorFeedback(context, successContext);
    } catch (err: unknown) {
        const executionStillCurrent = executionGate?.isCurrent() ?? true;
        executionGate?.dispose();
        if (!executionStillCurrent) {
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const errorEvent = tuningTimer.finish({
            result: 'error',
            errorCode: toPerfErrorCode(msg),
        });
        console.log(formatPerformanceEvent(errorEvent));
        vscode.window.showErrorMessage(`Tuning Advisor failed: ${msg}`);
    }
}
