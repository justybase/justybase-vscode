import { clampConfidence } from '../../../src/services/tuning/types';

export interface PostgreSqlExplainNode {
    id: number;
    nodeType: string;
    relationName?: string;
    schema?: string;
    alias?: string;
    startupCost: number;
    totalCost: number;
    planRows: number;
    planWidth: number;
    actualRows?: number;
    actualStartupTime?: number;
    actualTotalTime?: number;
    filter?: string;
    indexName?: string;
    joinType?: string;
    strategy?: string;
    parentRelationship?: string;
    children: PostgreSqlExplainNode[];
    raw: Record<string, unknown>;
}

export interface PostgreSqlExplainPlan {
    root: PostgreSqlExplainNode;
    planningTimeMs?: number;
    executionTimeMs?: number;
}

interface PostgreSqlExplainEnvelope {
    Plan?: Record<string, unknown>;
    'Planning Time'?: number;
    'Execution Time'?: number;
}

function toFiniteNumber(value: unknown): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
}

function toOptionalNumber(value: unknown): number | undefined {
    const parsed = toFiniteNumber(value);
    return parsed > 0 || value === 0 ? parsed : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeEnvelope(input: unknown): PostgreSqlExplainEnvelope {
    let parsed = input;
    if (typeof input === 'string') {
        parsed = JSON.parse(input);
    }

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
            return first as PostgreSqlExplainEnvelope;
        }
    }

    if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record['QUERY PLAN'])) {
            const first = (record['QUERY PLAN'] as unknown[])[0];
            if (first && typeof first === 'object') {
                return first as PostgreSqlExplainEnvelope;
            }
        }

        return record as PostgreSqlExplainEnvelope;
    }

    throw new Error('Unsupported PostgreSQL EXPLAIN JSON payload.');
}

function buildNode(node: Record<string, unknown>, nextId: () => number): PostgreSqlExplainNode {
    const childNodes = Array.isArray(node.Plans) ? node.Plans : [];

    return {
        id: nextId(),
        nodeType: toOptionalString(node['Node Type']) ?? 'Unknown',
        relationName: toOptionalString(node['Relation Name']),
        schema: toOptionalString(node['Schema']),
        alias: toOptionalString(node['Alias']),
        startupCost: toFiniteNumber(node['Startup Cost']),
        totalCost: toFiniteNumber(node['Total Cost']),
        planRows: toFiniteNumber(node['Plan Rows']),
        planWidth: toFiniteNumber(node['Plan Width']),
        actualRows: toOptionalNumber(node['Actual Rows']),
        actualStartupTime: toOptionalNumber(node['Actual Startup Time']),
        actualTotalTime: toOptionalNumber(node['Actual Total Time']),
        filter: toOptionalString(node.Filter),
        indexName: toOptionalString(node['Index Name']),
        joinType: toOptionalString(node['Join Type']),
        strategy: toOptionalString(node.Strategy),
        parentRelationship: toOptionalString(node['Parent Relationship']),
        children: childNodes
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
            .map((child) => buildNode(child, nextId)),
        raw: node,
    };
}

function getQualifiedRelationName(node: PostgreSqlExplainNode): string | undefined {
    if (!node.relationName) {
        return undefined;
    }

    return node.schema ? `${node.schema}.${node.relationName}` : node.relationName;
}

function formatExplainNodeLabel(node: PostgreSqlExplainNode): string {
    const relationName = getQualifiedRelationName(node);
    const relationSuffix = relationName ? ` table "${relationName}"` : '';
    const detailSuffix = [node.joinType ? `${node.joinType} join` : undefined, node.strategy]
        .filter(Boolean)
        .join(', ');
    const details = detailSuffix ? ` {${detailSuffix}}` : '';
    const confidence =
        node.actualRows !== undefined && node.planRows > 0
            ? clampConfidence(1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.planRows, 1)))))
            : 1;

    return `${node.nodeType}${relationSuffix}${details} (cost=${node.startupCost.toFixed(2)}..${node.totalCost.toFixed(2)} rows=${Math.round(node.planRows)} width=${Math.round(node.planWidth)} conf=${confidence.toFixed(2)})`;
}

function flattenExplainText(node: PostgreSqlExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatExplainNodeLabel(node)}`];

    if (node.filter) {
        lines.push(`${indent}   Filter: ${node.filter}`);
    }
    if (node.indexName) {
        lines.push(`${indent}   Index: ${node.indexName}`);
    }

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function isPostgreSqlExplainJson(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('[') || trimmed.startsWith('{');
}

export function parsePostgreSqlExplainJson(input: string | unknown): PostgreSqlExplainPlan {
    const envelope = normalizeEnvelope(input);
    if (!envelope.Plan || typeof envelope.Plan !== 'object') {
        throw new Error('PostgreSQL EXPLAIN JSON does not contain a Plan object.');
    }

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    return {
        root: buildNode(envelope.Plan, nextId),
        planningTimeMs: toOptionalNumber(envelope['Planning Time']),
        executionTimeMs: toOptionalNumber(envelope['Execution Time']),
    };
}

export function renderPostgreSqlExplainPlan(plan: PostgreSqlExplainPlan): string {
    const lines = flattenExplainText(plan.root);

    if (plan.planningTimeMs !== undefined) {
        lines.push(`Planning Time: ${plan.planningTimeMs.toFixed(3)} ms`);
    }
    if (plan.executionTimeMs !== undefined) {
        lines.push(`Execution Time: ${plan.executionTimeMs.toFixed(3)} ms`);
    }

    return lines.join('\n');
}

export function buildPostgreSqlExplainQuery(
    sql: string,
    options: {
        analyze?: boolean;
        verbose?: boolean;
        buffers?: boolean;
    } = {},
): string {
    const flags = [
        `FORMAT JSON`,
        `ANALYZE ${options.analyze ? 'TRUE' : 'FALSE'}`,
        `VERBOSE ${options.verbose ? 'TRUE' : 'FALSE'}`,
        `BUFFERS ${options.buffers ? 'TRUE' : 'FALSE'}`,
    ];

    return `EXPLAIN (${flags.join(', ')}) ${sql.trim()}`;
}
