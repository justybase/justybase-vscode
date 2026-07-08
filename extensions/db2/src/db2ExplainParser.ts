import { clampConfidence } from '../../../src/services/tuning/types';

export interface Db2ExplainNode {
    id: number;
    operatorType: string;
    objectSchema?: string;
    objectName?: string;
    totalCost: number;
    estimatedRows: number;
    iosCost?: number;
    cpuCost?: number;
    actualRows?: number;
    buffers?: number;
    sortRequired?: boolean;
    children: Db2ExplainNode[];
    raw: Record<string, unknown>;
}

export interface Db2ExplainPlan {
    root: Db2ExplainNode;
    totalCost: number;
    statementText?: string;
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
    if (value === undefined || value === null) {
        return undefined;
    }

    const parsed = toFiniteNumber(value);
    return parsed > 0 || value === 0 ? parsed : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true' || lower === 'yes' || lower === '1') {
            return true;
        }
        if (lower === 'false' || lower === 'no' || lower === '0') {
            return false;
        }
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    return undefined;
}

function caseGet(record: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined) {
            return record[key];
        }
    }
    return undefined;
}

function getChildArray(record: Record<string, unknown>): unknown[] {
    for (const key of ['children', 'CHILDREN', 'inputs', 'INPUTS']) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value;
        }
    }
    return [];
}

function buildNode(record: Record<string, unknown>, nextId: () => number): Db2ExplainNode {
    const childRecords = getChildArray(record);

    return {
        id: nextId(),
        operatorType: toOptionalString(caseGet(record, 'operator_type', 'OPERATOR_TYPE', 'operatorType')) ?? 'Unknown',
        objectSchema: toOptionalString(caseGet(record, 'object_schema', 'OBJECT_SCHEMA', 'objectSchema')),
        objectName: toOptionalString(caseGet(record, 'object_name', 'OBJECT_NAME', 'objectName')),
        totalCost: toFiniteNumber(caseGet(record, 'total_cost', 'TOTAL_COST', 'totalCost')),
        estimatedRows: toFiniteNumber(caseGet(record, 'estimated_rows', 'STREAM_COUNT', 'rows', 'estimatedRows')),
        iosCost: toOptionalNumber(caseGet(record, 'ios_cost', 'IO_COST', 'iosCost')),
        cpuCost: toOptionalNumber(caseGet(record, 'cpu_cost', 'CPU_COST', 'cpuCost')),
        actualRows: toOptionalNumber(caseGet(record, 'actual_rows', 'ACTUAL_ROWS', 'actualRows')),
        buffers: toOptionalNumber(caseGet(record, 'buffers', 'BUFFERS')),
        sortRequired: toOptionalBoolean(caseGet(record, 'sort_required', 'SORT_REQUIRED', 'sortRequired')),
        children: childRecords
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object' && !Array.isArray(child))
            .map((child) => buildNode(child, nextId)),
        raw: record,
    };
}

function normalizeEnvelope(input: unknown): Record<string, unknown> {
	let parsed = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch {
			throw new Error('Invalid JSON in Db2 EXPLAIN payload.');
		}
	}

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
            return first as Record<string, unknown>;
        }
        throw new Error('Unsupported Db2 EXPLAIN JSON payload: empty array.');
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;

        // Handle wrapper with a 'plan' key
        if (record['plan'] && typeof record['plan'] === 'object' && !Array.isArray(record['plan'])) {
            return record['plan'] as Record<string, unknown>;
        }
        if (record['PLAN'] && typeof record['PLAN'] === 'object' && !Array.isArray(record['PLAN'])) {
            return record['PLAN'] as Record<string, unknown>;
        }

        // Handle wrapper with array plan
        if (Array.isArray(record['plan'])) {
            const first = (record['plan'] as unknown[])[0];
            if (first && typeof first === 'object' && !Array.isArray(first)) {
                return first as Record<string, unknown>;
            }
        }
        if (Array.isArray(record['PLAN'])) {
            const first = (record['PLAN'] as unknown[])[0];
            if (first && typeof first === 'object' && !Array.isArray(first)) {
                return first as Record<string, unknown>;
            }
        }

        return record;
    }

    throw new Error('Unsupported Db2 EXPLAIN JSON payload.');
}

const DB2_PLAN_KEYS = [
    'operator_type', 'OPERATOR_TYPE', 'operatorType',
    'total_cost', 'TOTAL_COST', 'totalCost',
    'estimated_rows', 'STREAM_COUNT', 'estimatedRows',
];

export function isDb2ExplainJson(text: string): boolean {
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

        // Check direct keys
        if (DB2_PLAN_KEYS.some((key) => key in record)) {
            return true;
        }

        // Check wrapper 'plan' or 'PLAN' key
        for (const wrapper of ['plan', 'PLAN']) {
            const inner = record[wrapper];
            if (inner && typeof inner === 'object') {
                const target = Array.isArray(inner) ? inner[0] : inner;
                if (target && typeof target === 'object') {
                    if (DB2_PLAN_KEYS.some((key) => key in (target as Record<string, unknown>))) {
                        return true;
                    }
                }
            }
        }

        return false;
    } catch {
        return false;
    }
}

export function parseDb2ExplainJson(input: string | unknown): Db2ExplainPlan {
    const envelope = normalizeEnvelope(input);

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const root = buildNode(envelope, nextId);
    const statementText = toOptionalString(
        caseGet(envelope, 'statement_text', 'STATEMENT_TEXT', 'statementText', 'sql')
    );

    return {
        root,
        totalCost: root.totalCost,
        statementText,
    };
}

function getQualifiedObjectName(node: Db2ExplainNode): string | undefined {
    if (!node.objectName) {
        return undefined;
    }
    return node.objectSchema ? `${node.objectSchema}.${node.objectName}` : node.objectName;
}

function formatNodeLabel(node: Db2ExplainNode): string {
    const objectName = getQualifiedObjectName(node);
    const objectSuffix = objectName ? ` ${objectName}` : '';
    const confidence =
        node.actualRows !== undefined && node.estimatedRows > 0
            ? clampConfidence(1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.estimatedRows, 1)))))
            : 1;

    return `${node.operatorType}${objectSuffix} (cost=${node.totalCost.toFixed(2)} rows=${Math.round(node.estimatedRows)} conf=${confidence.toFixed(2)})`;
}

function flattenExplainText(node: Db2ExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatNodeLabel(node)}`];

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function renderDb2ExplainPlan(plan: Db2ExplainPlan): string {
    const lines = flattenExplainText(plan.root);
    lines.push(`Total Cost: ${plan.totalCost.toFixed(2)}`);
    return lines.join('\n');
}

export function buildDb2ExplainQuery(sql: string): string {
    return `EXPLAIN PLAN FOR ${sql.trim()}`;
}

export function buildDb2ExplainRetrieveQuery(): string {
    return 'SELECT OPERATOR_TYPE, OBJECT_SCHEMA, OBJECT_NAME, TOTAL_COST, STREAM_COUNT, IO_COST, CPU_COST, COLUMN_NAMES FROM EXPLAIN_OPERATOR ORDER BY OPERATOR_ID';
}
