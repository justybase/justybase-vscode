import { clampConfidence } from '../../../src/services/tuning/types';

export interface VerticaExplainNode {
    id: number;
    operation: string;
    path: string;
    objectName?: string;
    objectSchema?: string;
    cost: number;
    estimatedRows: number;
    rowWidth?: number;
    producerCount?: number;
    actualRows?: number;
    executionTimeMs?: number;
    filter?: string;
    projection?: string;
    children: VerticaExplainNode[];
    raw: Record<string, unknown>;
}

export interface VerticaExplainPlan {
    root: VerticaExplainNode;
    totalCost: number;
    executionTimeMs?: number;
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

function resolveKey(record: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (key in record) {
            return record[key];
        }
    }
    return undefined;
}

function buildNode(record: Record<string, unknown>, nextId: () => number): VerticaExplainNode {
    const childArrays = resolveKey(record, 'children', 'inputs', 'plans');
    const childNodes = Array.isArray(childArrays) ? childArrays : [];

    const pathId = resolveKey(record, 'path_id', 'PATH_ID', 'PATH ID', 'pathId');
    const operation = toOptionalString(resolveKey(record, 'operation', 'OPERATION')) ?? 'Unknown';
    const objectName = toOptionalString(resolveKey(record, 'object_name', 'OBJECT_NAME', 'PROJECTION_NAME', 'projection_name'));
    const objectSchema = toOptionalString(resolveKey(record, 'object_schema', 'SCHEMA', 'schema'));
    const cost = toFiniteNumber(resolveKey(record, 'cost', 'COST', 'estimated_cost'));
    const estimatedRows = toFiniteNumber(resolveKey(record, 'rows', 'ESTIMATED_ROWS', 'estimated_rows', 'cardinality'));
    const rowWidth = toOptionalNumber(resolveKey(record, 'width', 'ROW_WIDTH', 'row_width'));
    const producerCount = toOptionalNumber(resolveKey(record, 'producer_count', 'PRODUCER_COUNT'));
    const actualRows = toOptionalNumber(resolveKey(record, 'actual_rows'));
    const executionTimeMs = toOptionalNumber(resolveKey(record, 'execution_time_ms'));
    const filter = toOptionalString(resolveKey(record, 'filter', 'FILTER_PREDICATES', 'filter_predicates'));
    const projection = toOptionalString(resolveKey(record, 'projection', 'PROJECTION_NAME', 'projection_name'));

    return {
        id: pathId !== undefined ? toFiniteNumber(pathId) : nextId(),
        operation,
        path: String(pathId ?? nextId()),
        objectName,
        objectSchema,
        cost,
        estimatedRows,
        rowWidth,
        producerCount,
        actualRows,
        executionTimeMs,
        filter,
        projection,
        children: childNodes
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
            .map((child) => buildNode(child, nextId)),
        raw: record,
    };
}

export function flattenNodes(root: VerticaExplainNode): VerticaExplainNode[] {
    const result: VerticaExplainNode[] = [root];
    for (const child of root.children) {
        result.push(...flattenNodes(child));
    }
    return result;
}

function computeTotalCost(root: VerticaExplainNode): number {
    let maxCost = root.cost;
    for (const child of root.children) {
        const childCost = computeTotalCost(child);
        if (childCost > maxCost) {
            maxCost = childCost;
        }
    }
    return maxCost;
}

interface VerticaExplainEnvelope {
    plan?: Record<string, unknown>;
    execution_time_ms?: number;
}

function normalizeEnvelope(input: unknown): VerticaExplainEnvelope {
	let parsed = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch {
			throw new Error('Invalid JSON in Vertica EXPLAIN payload.');
		}
	}

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
            return normalizeEnvelope(first);
        }
    }

    if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;

        // Handle wrapper with plan/Plan key
        const planValue = resolveKey(record, 'plan', 'Plan');
        if (planValue && typeof planValue === 'object' && !Array.isArray(planValue)) {
            return {
                plan: planValue as Record<string, unknown>,
                execution_time_ms: toOptionalNumber(
                    resolveKey(record, 'execution_time_ms', 'Execution Time', 'executionTimeMs'),
                ),
            };
        }

        // No wrapper – the record itself is the root plan node
        return {
            plan: record,
            execution_time_ms: toOptionalNumber(
                resolveKey(record, 'execution_time_ms', 'Execution Time', 'executionTimeMs'),
            ),
        };
    }

    throw new Error('Unsupported Vertica EXPLAIN JSON payload.');
}

export function isVerticaExplainJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        return false;
    }

    try {
        let parsed: unknown = JSON.parse(trimmed);

        if (Array.isArray(parsed)) {
            parsed = parsed[0];
        }

        if (!parsed || typeof parsed !== 'object') {
            return false;
        }

        const record = parsed as Record<string, unknown>;

        // Check for wrapper with plan/Plan key containing Vertica-style content
        const planValue = resolveKey(record, 'plan', 'Plan');
        if (planValue && typeof planValue === 'object') {
            const inner = planValue as Record<string, unknown>;
            return hasVerticaKeys(inner);
        }

        return hasVerticaKeys(record);
    } catch {
        return false;
    }
}

function hasVerticaKeys(record: Record<string, unknown>): boolean {
    const verticaKeys = ['path_id', 'PATH_ID', 'PATH ID', 'operation', 'OPERATION'];
    return verticaKeys.some((key) => key in record);
}

export function parseVerticaExplainJson(input: string | unknown): VerticaExplainPlan {
    const envelope = normalizeEnvelope(input);
    if (!envelope.plan || typeof envelope.plan !== 'object') {
        throw new Error('Vertica EXPLAIN JSON does not contain a plan object.');
    }

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const root = buildNode(envelope.plan, nextId);

    return {
        root,
        totalCost: computeTotalCost(root),
        executionTimeMs: envelope.execution_time_ms,
    };
}

function formatNodeLabel(node: VerticaExplainNode): string {
    const objectSuffix = node.objectName
        ? node.objectSchema
            ? ` ${node.objectSchema}.${node.objectName}`
            : ` ${node.objectName}`
        : '';

    const confidence =
        node.actualRows !== undefined && node.estimatedRows > 0
            ? clampConfidence(
                1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.estimatedRows, 1)))),
            )
            : 1;

    const parts = [`cost=${node.cost.toFixed(2)}`, `rows=${Math.round(node.estimatedRows)}`];
    if (node.rowWidth !== undefined) {
        parts.push(`width=${Math.round(node.rowWidth)}`);
    }
    parts.push(`conf=${confidence.toFixed(2)}`);

    return `[PATH ${node.path}] ${node.operation}${objectSuffix} (${parts.join(' ')})`;
}

function flattenExplainText(node: VerticaExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatNodeLabel(node)}`];

    if (node.filter) {
        lines.push(`${indent}   Filter: ${node.filter}`);
    }
    if (node.projection) {
        lines.push(`${indent}   Projection: ${node.projection}`);
    }

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function renderVerticaExplainPlan(plan: VerticaExplainPlan): string {
    const lines = flattenExplainText(plan.root);

    lines.push(`Total Cost: ${plan.totalCost.toFixed(2)}`);
    if (plan.executionTimeMs !== undefined) {
        lines.push(`Execution Time: ${plan.executionTimeMs.toFixed(3)} ms`);
    }

    return lines.join('\n');
}

export function buildVerticaExplainQuery(
    sql: string,
    options: { verbose?: boolean } = {},
): string {
    if (options.verbose) {
        return `EXPLAIN VERBOSE ${sql.trim()}`;
    }
    return `EXPLAIN ${sql.trim()}`;
}
