import {
    clampConfidence,
    createTuningReport,
    type TuningRecommendation,
    type TuningReport,
} from '../../../src/services/tuning/types';

export interface SnowflakeProfileNode {
    operation: string;
    objects: string[];
    expressions: string[];
    metrics: Record<string, number | string>;
    children: SnowflakeProfileNode[];
}

export interface SnowflakeExplainPlan {
    root: SnowflakeProfileNode;
    raw: unknown;
}

interface SnowflakeOperatorStatRow {
    OPERATOR_TYPE?: string;
    OPERATOR_NAME?: string;
    PARENT_OPERATORS?: string;
    OBJECTS?: string;
    EXPRESSIONS?: string;
    OUTPUT_ROWS?: number | string;
    BYTES_SCANNED?: number | string;
    PARTITIONS_SCANNED?: number | string;
    PARTITIONS_TOTAL?: number | string;
    SPILLED_BYTES?: number | string;
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === 'string') {
        const normalized = value.replace(/,/g, '').trim();
        if (!normalized) {
            return undefined;
        }

        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item)).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/\s*,\s*/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function createNodeFromRecord(record: Record<string, unknown>): SnowflakeProfileNode {
    const childrenSource = Array.isArray(record.children)
        ? record.children
        : Array.isArray(record.operations)
          ? record.operations
          : Array.isArray(record.plans)
            ? record.plans
            : [];

    const metrics: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(record)) {
        if (
            value == null ||
            ['children', 'operations', 'plans', 'operation', 'name', 'objects', 'expressions'].includes(key)
        ) {
            continue;
        }

        if (typeof value === 'number' || typeof value === 'string') {
            metrics[key] = value;
        }
    }

    return {
        operation: String(record.operation || record.name || record.id || 'Operation'),
        objects: toStringArray(record.objects),
        expressions: toStringArray(record.expressions),
        metrics,
        children: childrenSource
            .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
            .map((child) => createNodeFromRecord(child)),
    };
}

function flattenNodes(root: SnowflakeProfileNode): SnowflakeProfileNode[] {
    const output: SnowflakeProfileNode[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        output.push(current);
        for (let index = current.children.length - 1; index >= 0; index--) {
            stack.push(current.children[index]);
        }
    }

    return output;
}

export function buildSnowflakeExplainQuery(sql: string): string {
    return `EXPLAIN USING JSON ${sql.trim()}`;
}

export function buildSnowflakeRecentQueryHistoryQuery(limit = 20): string {
    return `
        SELECT
            QUERY_ID,
            QUERY_TEXT,
            DATABASE_NAME,
            SCHEMA_NAME,
            WAREHOUSE_NAME,
            ROLE_NAME,
            EXECUTION_STATUS,
            TOTAL_ELAPSED_TIME,
            BYTES_SCANNED,
            ROWS_PRODUCED,
            START_TIME
        FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION(RESULT_LIMIT => ${Math.max(1, Math.min(limit, 100))}))
        ORDER BY START_TIME DESC
    `;
}

export function buildSnowflakeQueryOperatorStatsQuery(queryIdExpression: string): string {
    return `SELECT * FROM TABLE(GET_QUERY_OPERATOR_STATS(${queryIdExpression}))`;
}

export function isSnowflakeExplainJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return false;
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return typeof parsed === 'object' && parsed !== null;
    } catch {
        return false;
    }
}

export function parseSnowflakeExplainJson(text: string): SnowflakeExplainPlan {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const first = parsed[0] as Record<string, unknown>;
        if (typeof first.plan === 'object' && first.plan !== null) {
            return {
                root: createNodeFromRecord(first.plan as Record<string, unknown>),
                raw: parsed,
            };
        }

        return {
            root: createNodeFromRecord({
                operation: 'Query',
                children: parsed as Record<string, unknown>[],
            }),
            raw: parsed,
        };
    }

    if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const rootSource =
            typeof record.plan === 'object' && record.plan !== null ? (record.plan as Record<string, unknown>) : record;
        return {
            root: createNodeFromRecord(rootSource),
            raw: parsed,
        };
    }

    throw new Error('Unsupported Snowflake explain JSON payload.');
}

export function renderSnowflakeExplainPlan(plan: SnowflakeExplainPlan): string {
    const lines: string[] = [];

    const visit = (node: SnowflakeProfileNode, depth: number): void => {
        const indent = '  '.repeat(depth);
        const metricSummary = Object.entries(node.metrics)
            .slice(0, 4)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ');
        const objectSummary = node.objects.length > 0 ? ` [${node.objects.join(', ')}]` : '';
        const expressionSummary = node.expressions.length > 0 ? ` {${node.expressions.join(', ')}}` : '';
        lines.push(
            `${indent}- ${node.operation}${objectSummary}${expressionSummary}${metricSummary ? ` (${metricSummary})` : ''}`,
        );
        for (const child of node.children) {
            visit(child, depth + 1);
        }
    };

    visit(plan.root, 0);
    return lines.join('\n');
}

export function renderSnowflakeQueryProfileMarkdown(rows: readonly Record<string, unknown>[]): string {
    if (rows.length === 0) {
        return '# Snowflake Query Profile\n\nNo operator statistics were returned.';
    }

    const normalizedRows = rows.map((row) => row as SnowflakeOperatorStatRow);
    const lines = [
        '# Snowflake Query Profile',
        '',
        '| Operator | Output Rows | Bytes Scanned | Partitions | Spilled Bytes | Objects |',
        '| --- | ---: | ---: | --- | ---: | --- |',
    ];

    for (const row of normalizedRows) {
        const operator = row.OPERATOR_NAME || row.OPERATOR_TYPE || 'Operator';
        const partitionsScanned = toNumber(row.PARTITIONS_SCANNED);
        const partitionsTotal = toNumber(row.PARTITIONS_TOTAL);
        const partitionSummary =
            partitionsScanned !== undefined || partitionsTotal !== undefined
                ? `${partitionsScanned ?? 0}/${partitionsTotal ?? 0}`
                : '';
        lines.push(
            `| ${operator} | ${toNumber(row.OUTPUT_ROWS) ?? ''} | ${toNumber(row.BYTES_SCANNED) ?? ''} | ${partitionSummary} | ${toNumber(row.SPILLED_BYTES) ?? ''} | ${row.OBJECTS ?? ''} |`,
        );
    }

    return lines.join('\n');
}

export function analyzeSnowflakeExplainPlan(explainPlanText: string, sql: string): TuningReport {
    if (!isSnowflakeExplainJson(explainPlanText)) {
        return createTuningReport([], sql.length);
    }

    const plan = parseSnowflakeExplainJson(explainPlanText);
    const nodes = flattenNodes(plan.root);
    const recommendations: TuningRecommendation[] = [];

    if (/\bSELECT\s+\*/i.test(sql)) {
        recommendations.push({
            id: 'SFTA-001',
            title: 'Avoid SELECT * on Snowflake workloads',
            summary: 'Selecting every column increases bytes scanned and can reduce pruning effectiveness.',
            severity: 'warning',
            confidence: clampConfidence(0.74),
            risk: 'medium',
            actions: ['Project only required columns.', 'Re-run EXPLAIN/profile and compare bytes scanned.'],
            evidence: [{ source: 'sql_analysis', summary: 'Query contains SELECT *.' }],
        });
    }

    const scanNode = nodes.find((node) => /scan/i.test(node.operation));
    if (scanNode) {
        recommendations.push({
            id: 'SFTA-002',
            title: 'Inspect scan-heavy operators first',
            summary: `${scanNode.operation} appears in the Snowflake plan.`,
            severity: 'info',
            confidence: clampConfidence(0.7),
            risk: 'medium',
            actions: [
                'Review clustering/pruning opportunities and predicate selectivity.',
                'Limit projected VARIANT/object fields where practical.',
            ],
            evidence: [
                {
                    source: 'explain_plan',
                    summary: scanNode.operation,
                    details: scanNode.objects.join(', '),
                },
            ],
        });
    }

    const exchangeNode = nodes.find((node) => /exchange|repartition/i.test(node.operation));
    if (exchangeNode) {
        recommendations.push({
            id: 'SFTA-003',
            title: 'Repartition or exchange step detected',
            summary: 'Data movement can materially increase elapsed time and warehouse cost.',
            severity: 'warning',
            confidence: clampConfidence(0.8),
            risk: 'medium',
            actions: [
                'Reduce intermediate row volume before repartition points.',
                'Check join keys and FLATTEN usage for unnecessary row explosion.',
            ],
            evidence: [{ source: 'explain_plan', summary: exchangeNode.operation }],
        });
    }

    const sortNode = nodes.find((node) => /sort/i.test(node.operation));
    if (sortNode) {
        recommendations.push({
            id: 'SFTA-004',
            title: 'Sort operator detected',
            summary: 'Large sorts can spill and increase warehouse time.',
            severity: 'info',
            confidence: clampConfidence(0.66),
            risk: 'low',
            actions: [
                'Verify ORDER BY is required at this stage.',
                'Push filters earlier or reduce row width before sorting.',
            ],
            evidence: [{ source: 'explain_plan', summary: sortNode.operation }],
        });
    }

    return createTuningReport(recommendations, sql.length);
}
