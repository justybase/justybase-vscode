import { clampConfidence } from '../../../src/services/tuning/types';

export interface OracleExplainNode {
    id: number;
    operation: string;
    options?: string;
    objectOwner?: string;
    objectName?: string;
    objectType?: string;
    cost?: number;
    cardinality: number;
    bytes?: number;
    cpuCost?: number;
    ioCost?: number;
    actualRows?: number;
    actualTimeMs?: number;
    filter?: string;
    accessPredicates?: string;
    children: OracleExplainNode[];
    raw: Record<string, unknown>;
}

export interface OracleExplainPlan {
    root: OracleExplainNode;
    statementId?: string;
}

function resolveKey(record: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (key in record) {
            return record[key];
        }
    }
    return undefined;
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

function buildNode(record: Record<string, unknown>, nextId: () => number): OracleExplainNode {
    const childArrays = resolveKey(record, 'children', 'Children', 'CHILDREN', 'Plans');
    const childNodes = Array.isArray(childArrays) ? childArrays : [];

    return {
        id: nextId(),
        operation: toOptionalString(resolveKey(record, 'operation', 'Operation', 'OPERATION')) ?? 'Unknown',
        options: toOptionalString(resolveKey(record, 'options', 'Options', 'OPTIONS')),
        objectOwner: toOptionalString(resolveKey(record, 'objectOwner', 'object_owner', 'OBJECT_OWNER')),
        objectName: toOptionalString(resolveKey(record, 'objectName', 'object_name', 'OBJECT_NAME')),
        objectType: toOptionalString(resolveKey(record, 'objectType', 'object_type', 'OBJECT_TYPE')),
        cost: toOptionalNumber(resolveKey(record, 'cost', 'Cost', 'COST')),
        cardinality: toFiniteNumber(resolveKey(record, 'cardinality', 'Cardinality', 'CARDINALITY')),
        bytes: toOptionalNumber(resolveKey(record, 'bytes', 'Bytes', 'BYTES')),
        cpuCost: toOptionalNumber(resolveKey(record, 'cpuCost', 'cpu_cost', 'CPU_COST')),
        ioCost: toOptionalNumber(resolveKey(record, 'ioCost', 'io_cost', 'IO_COST')),
        actualRows: toOptionalNumber(resolveKey(record, 'actualRows', 'actual_rows', 'ACTUAL_ROWS')),
        actualTimeMs: toOptionalNumber(resolveKey(record, 'actualTimeMs', 'actual_time_ms', 'ACTUAL_TIME_MS')),
        filter: toOptionalString(resolveKey(record, 'filter', 'filterPredicates', 'filter_predicates', 'FILTER_PREDICATES')),
        accessPredicates: toOptionalString(resolveKey(record, 'accessPredicates', 'access_predicates', 'ACCESS_PREDICATES')),
        children: childNodes
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
            .map((child) => buildNode(child, nextId)),
        raw: record,
    };
}

interface OracleEnvelope {
    plan?: Record<string, unknown>;
    statementId?: string;
}

function normalizeEnvelope(input: unknown): OracleEnvelope {
	let parsed = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch {
			throw new Error('Invalid JSON in Oracle EXPLAIN PLAN payload.');
		}
	}

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
            return { plan: first as Record<string, unknown> };
        }
    }

    if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;

        const planValue = resolveKey(record, 'plan', 'Plan', 'PLAN');
        if (planValue && typeof planValue === 'object' && !Array.isArray(planValue)) {
            return {
                plan: planValue as Record<string, unknown>,
                statementId: toOptionalString(resolveKey(record, 'statementId', 'statement_id', 'STATEMENT_ID')),
            };
        }

        if (resolveKey(record, 'operation', 'Operation', 'OPERATION') !== undefined) {
            return {
                plan: record,
                statementId: toOptionalString(resolveKey(record, 'statementId', 'statement_id', 'STATEMENT_ID')),
            };
        }

        return { plan: record };
    }

    throw new Error('Unsupported Oracle EXPLAIN PLAN JSON payload.');
}

export function isOracleExplainJson(text: string): boolean {
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

        const planValue = resolveKey(record, 'plan', 'Plan', 'PLAN');
        if (planValue && typeof planValue === 'object') {
            const inner = planValue as Record<string, unknown>;
            return resolveKey(inner, 'operation', 'Operation', 'OPERATION') !== undefined;
        }

        return resolveKey(record, 'operation', 'Operation', 'OPERATION') !== undefined;
    } catch {
        return false;
    }
}

export function parseOracleExplainJson(input: string | unknown): OracleExplainPlan {
    const envelope = normalizeEnvelope(input);
    if (!envelope.plan || typeof envelope.plan !== 'object') {
        throw new Error('Oracle EXPLAIN PLAN JSON does not contain a valid plan object.');
    }

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    return {
        root: buildNode(envelope.plan, nextId),
        statementId: envelope.statementId,
    };
}

function formatExplainNodeLabel(node: OracleExplainNode): string {
    const optionsSuffix = node.options ? ` ${node.options}` : '';
    const objectSuffix = node.objectName ? ` ${node.objectName}` : '';
    const costPart = node.cost !== undefined ? `cost=${node.cost}` : 'cost=?';
    const confidence =
        node.actualRows !== undefined && node.cardinality > 0
            ? clampConfidence(1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.cardinality, 1)))))
            : 1;

    return `${node.operation}${optionsSuffix}${objectSuffix} (${costPart} card=${Math.round(node.cardinality)} bytes=${node.bytes ?? 0} conf=${confidence.toFixed(2)})`;
}

function flattenExplainText(node: OracleExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatExplainNodeLabel(node)}`];

    if (node.filter) {
        lines.push(`${indent}   Filter: ${node.filter}`);
    }
    if (node.accessPredicates) {
        lines.push(`${indent}   Access: ${node.accessPredicates}`);
    }

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function renderOracleExplainPlan(plan: OracleExplainPlan): string {
    const lines = flattenExplainText(plan.root);

    if (plan.statementId) {
        lines.push(`Statement ID: ${plan.statementId}`);
    }

    return lines.join('\n');
}

export function buildOracleExplainQuery(sql: string): string {
    return `EXPLAIN PLAN FOR ${sql.trim()}`;
}

export function buildOracleExplainRetrieveQuery(): string {
    return [
        'SELECT ID, PARENT_ID, OPERATION, OPTIONS, OBJECT_OWNER, OBJECT_NAME, OBJECT_TYPE,',
        '       COST, CARDINALITY, BYTES, CPU_COST, IO_COST, FILTER_PREDICATES, ACCESS_PREDICATES',
        'FROM PLAN_TABLE',
        'ORDER BY ID',
    ].join('\n');
}
