import { clampConfidence } from '../../../src/services/tuning/types';

export interface DuckDbExplainNode {
    id: number;
    nodeType: string;
    tableName?: string;
    extraInfo?: string;
    estimatedCardinality: number;
    actualRows?: number;
    timingMs?: number;
    children: DuckDbExplainNode[];
    raw: Record<string, unknown>;
}

export interface DuckDbExplainPlan {
    root: DuckDbExplainNode;
    totalTimingMs?: number;
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

function extractTableName(extraInfo: string | undefined, raw: Record<string, unknown>): string | undefined {
    const explicit = toOptionalString(raw['table_name']);
    if (explicit) {
        return explicit;
    }

    if (!extraInfo) {
        return undefined;
    }

    // DuckDB extra_info often contains table references like "[table_name]" or bare identifiers
    const bracketMatch = /\[([^\]]+)\]/.exec(extraInfo);
    if (bracketMatch) {
        return bracketMatch[1];
    }

    // Look for a leading identifier (e.g. "schema.table" or just "table")
    const identMatch = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(extraInfo.trim());
    if (identMatch) {
        return identMatch[1];
    }

    return undefined;
}

function buildNode(node: Record<string, unknown>, nextId: () => number): DuckDbExplainNode {
    const childNodes = Array.isArray(node.children) ? node.children : [];
    const extraInfo = toOptionalString(node['extra_info']);

    return {
        id: nextId(),
        nodeType: toOptionalString(node['type']) ?? toOptionalString(node['name']) ?? toOptionalString(node['node_type']) ?? 'Unknown',
        tableName: extractTableName(extraInfo, node),
        extraInfo,
        estimatedCardinality: toFiniteNumber(node['estimated_cardinality']),
        actualRows: toOptionalNumber(node['actual_rows']),
        timingMs: toOptionalNumber(node['timing']) ?? toOptionalNumber(node['operator_timing']),
        children: childNodes
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
            .map((child) => buildNode(child, nextId)),
        raw: node,
    };
}

function flattenNodes(root: DuckDbExplainNode): DuckDbExplainNode[] {
    const nodes: DuckDbExplainNode[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }

        nodes.push(current);
        for (let index = current.children.length - 1; index >= 0; index--) {
            stack.push(current.children[index]);
        }
    }

    return nodes;
}

function nodeConfidence(node: DuckDbExplainNode): number {
    if (node.actualRows !== undefined) {
        return clampConfidence(
            1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.estimatedCardinality, 1)))),
        );
    }
    return 1;
}

function formatNodeLine(node: DuckDbExplainNode, depth: number): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const actualPart = node.actualRows !== undefined ? ` actual=${Math.round(node.actualRows)}` : '';
    const timePart = node.timingMs !== undefined ? ` time=${node.timingMs.toFixed(2)}ms` : '';
    const conf = nodeConfidence(node);

    const lines = [
        `${indent}${node.nodeType} (est=${Math.round(node.estimatedCardinality)}${actualPart}${timePart} conf=${conf.toFixed(2)})`,
    ];

    if (node.extraInfo) {
        lines.push(`${indent}   Extra: ${node.extraInfo}`);
    }

    for (const child of node.children) {
        lines.push(...formatNodeLine(child, depth + 1));
    }

    return lines;
}

export function isDuckDbExplainJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return false;
    }

    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
            const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
            if (obj && typeof obj === 'object') {
                return 'type' in obj || 'name' in obj || 'children' in obj;
            }
        }
    } catch {
        return false;
    }

    return false;
}

export function parseDuckDbExplainJson(input: string | unknown): DuckDbExplainPlan {
	let parsed: unknown = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch {
			throw new Error('Invalid JSON in DuckDB EXPLAIN payload.');
		}
	}

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
            parsed = first;
        }
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('DuckDB EXPLAIN JSON payload is not an object.');
    }

    const record = parsed as Record<string, unknown>;

    // Handle wrapper objects that contain a children array with the root plan
    let rootRecord = record;
    if (!record['type'] && !record['name'] && !record['node_type'] && Array.isArray(record['children'])) {
        const firstChild = (record['children'] as unknown[])[0];
        if (firstChild && typeof firstChild === 'object') {
            rootRecord = firstChild as Record<string, unknown>;
        }
    }

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const root = buildNode(rootRecord, nextId);
    const totalTimingMs = root.timingMs ?? toOptionalNumber(record['timing']) ?? toOptionalNumber(record['total_timing']);

    return { root, totalTimingMs };
}

export function renderDuckDbExplainPlan(plan: DuckDbExplainPlan): string {
    const lines = formatNodeLine(plan.root, 0);

    if (plan.totalTimingMs !== undefined) {
        lines.push(`Total Timing: ${plan.totalTimingMs.toFixed(3)} ms`);
    }

    return lines.join('\n');
}

export function buildDuckDbExplainQuery(sql: string, options?: { analyze?: boolean }): string {
    if (options?.analyze) {
        return `EXPLAIN ANALYZE ${sql.trim()}`;
    }
    return `EXPLAIN (FORMAT JSON) ${sql.trim()}`;
}

export { flattenNodes };
