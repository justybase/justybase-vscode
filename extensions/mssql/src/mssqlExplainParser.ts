import { clampConfidence } from '../../../src/services/tuning/types';

export interface MsSqlExplainNode {
    id: number;
    physicalOp: string;
    logicalOp: string;
    estimatedRows: number;
    estimatedCost: number;
    estimatedSubtreeCost: number;
    actualRows?: number;
    actualElapsedMs?: number;
    objectName?: string;
    outputList?: string[];
    warnings?: string;
    estimatedIoCost?: number;
    estimatedCpuCost?: number;
    children: MsSqlExplainNode[];
    raw: Record<string, unknown>;
}

export interface MsSqlExplainPlan {
    root: MsSqlExplainNode;
    totalSubtreeCost: number;
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

function toOptionalStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const strings = value
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim());
        return strings.length > 0 ? strings : undefined;
    }
    return undefined;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined) {
            return record[key];
        }
    }
    return undefined;
}

function extractObjectName(record: Record<string, unknown>): string | undefined {
    const argument = record['Argument'] ?? record['argument'];
    if (typeof argument === 'string') {
        const objectMatch = /OBJECT:\(\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]\)/i.exec(argument);
        if (objectMatch) {
            return `${objectMatch[2]}.${objectMatch[3]}`;
        }
        const simpleMatch = /OBJECT:\(\[([^\]]+)\]\)/i.exec(argument);
        if (simpleMatch) {
            return simpleMatch[1];
        }
    }

    const obj = record['Object'] ?? record['object'];
    if (typeof obj === 'string' && obj.trim().length > 0) {
        return obj.trim();
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const objRecord = obj as Record<string, unknown>;
        const schema = toOptionalString(objRecord['Schema'] ?? objRecord['schema']);
        const table = toOptionalString(objRecord['Table'] ?? objRecord['table']);
        if (table) {
            return schema ? `${schema}.${table}` : table;
        }
    }

    return undefined;
}

function extractChildRecords(record: Record<string, unknown>): Record<string, unknown>[] {
    for (const key of ['children', 'Children', 'inputs', 'Inputs', 'RelOp', 'relop']) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value.filter(
                (child): child is Record<string, unknown> => !!child && typeof child === 'object',
            );
        }
    }
    return [];
}

function buildNode(record: Record<string, unknown>, nextId: () => number): MsSqlExplainNode {
    const childRecords = extractChildRecords(record);

    return {
        id: nextId(),
        physicalOp: toOptionalString(pick(record, 'PhysicalOp', 'physical_op', 'physicalOp')) ?? 'Unknown',
        logicalOp: toOptionalString(pick(record, 'LogicalOp', 'logical_op', 'logicalOp')) ?? 'Unknown',
        estimatedRows: toFiniteNumber(pick(record, 'EstimateRows', 'estimated_rows', 'estimateRows')),
        estimatedCost: toFiniteNumber(pick(record, 'EstimatedCost', 'estimated_cost', 'estimatedCost')),
        estimatedSubtreeCost: toFiniteNumber(
            pick(record, 'EstimatedTotalSubtreeCost', 'estimated_subtree_cost', 'estimatedSubtreeCost', 'TotalSubtreeCost'),
        ),
        actualRows: toOptionalNumber(pick(record, 'ActualRows', 'actual_rows', 'actualRows')),
        actualElapsedMs: toOptionalNumber(pick(record, 'ActualElapsedms', 'actual_elapsed_ms', 'actualElapsedMs')),
        objectName: extractObjectName(record),
        outputList: toOptionalStringArray(pick(record, 'OutputList', 'output_list', 'outputList') as unknown[]),
        warnings: toOptionalString(pick(record, 'Warnings', 'warnings')),
        estimatedIoCost: toOptionalNumber(pick(record, 'EstimateIO', 'estimated_io_cost', 'estimateIO')),
        estimatedCpuCost: toOptionalNumber(pick(record, 'EstimateCPU', 'estimated_cpu_cost', 'estimateCPU')),
        children: childRecords.map((child) => buildNode(child, nextId)),
        raw: record,
    };
}

function normalizeEnvelope(input: unknown): Record<string, unknown> {
	let parsed = input;
	if (typeof input === 'string') {
		try {
			parsed = JSON.parse(input);
		} catch {
			throw new Error('Invalid JSON in MS SQL Server execution plan payload.');
		}
	}

    if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
            return first as Record<string, unknown>;
        }
    }

    if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;

        if (record['Plan'] && typeof record['Plan'] === 'object') {
            return record['Plan'] as Record<string, unknown>;
        }

        if (record['plan'] && typeof record['plan'] === 'object') {
            return record['plan'] as Record<string, unknown>;
        }

        if (record['RelOp'] && typeof record['RelOp'] === 'object' && !Array.isArray(record['RelOp'])) {
            return record['RelOp'] as Record<string, unknown>;
        }

        if (record['ShowPlanXML'] && typeof record['ShowPlanXML'] === 'object') {
            const showPlan = record['ShowPlanXML'] as Record<string, unknown>;
            const batchSequence = showPlan['BatchSequence'] ?? showPlan['batchSequence'];
            if (batchSequence && typeof batchSequence === 'object') {
                return traverseToRelOp(batchSequence as Record<string, unknown>) ?? record;
            }
        }

        return record;
    }

    throw new Error('Unsupported MS SQL Server execution plan JSON payload.');
}

function traverseToRelOp(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    if (obj['RelOp'] && typeof obj['RelOp'] === 'object') {
        return obj['RelOp'] as Record<string, unknown>;
    }

    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === 'object') {
                    const result = traverseToRelOp(item as Record<string, unknown>);
                    if (result) {
                        return result;
                    }
                }
            }
        } else if (value && typeof value === 'object') {
            const result = traverseToRelOp(value as Record<string, unknown>);
            if (result) {
                return result;
            }
        }
    }

    return undefined;
}

const MSSQL_PLAN_KEYS = [
    'PhysicalOp', 'physical_op', 'physicalOp',
    'LogicalOp', 'logical_op', 'logicalOp',
    'EstimateRows', 'estimated_rows',
    'EstimatedTotalSubtreeCost', 'estimated_subtree_cost',
];

function looksLikeMsSqlPlan(obj: Record<string, unknown>): boolean {
    return MSSQL_PLAN_KEYS.some((key) => key in obj);
}

function deepContainsMsSqlKeys(value: unknown, depth: number): boolean {
    if (depth <= 0 || !value || typeof value !== 'object') {
        return false;
    }

    if (Array.isArray(value)) {
        return value.some((item) => deepContainsMsSqlKeys(item, depth - 1));
    }

    const record = value as Record<string, unknown>;
    if (looksLikeMsSqlPlan(record)) {
        return true;
    }

    for (const key of ['Plan', 'plan', 'RelOp', 'ShowPlanXML', 'children', 'inputs']) {
        if (record[key] !== undefined) {
            return deepContainsMsSqlKeys(record[key], depth - 1);
        }
    }

    return false;
}

export function isMsSqlExplainJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
        return false;
    }

    try {
        const parsed: unknown = JSON.parse(trimmed);
        return deepContainsMsSqlKeys(parsed, 5);
    } catch {
        return false;
    }
}

export function parseMsSqlExplainJson(input: string | unknown): MsSqlExplainPlan {
    const envelope = normalizeEnvelope(input);

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const root = buildNode(envelope, nextId);

    return {
        root,
        totalSubtreeCost: root.estimatedSubtreeCost,
    };
}

function formatExplainNodeLabel(node: MsSqlExplainNode): string {
    const objectSuffix = node.objectName ? ` ${node.objectName}` : '';
    const confidence =
        node.actualRows !== undefined && node.estimatedRows > 0
            ? clampConfidence(
                  1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.estimatedRows, 1)))),
              )
            : 1;

    return `${node.physicalOp} (${node.logicalOp})${objectSuffix} (cost=${node.estimatedCost.toFixed(4)} rows=${Math.round(node.estimatedRows)} subtree=${node.estimatedSubtreeCost.toFixed(4)} conf=${confidence.toFixed(2)})`;
}

function flattenExplainText(node: MsSqlExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatExplainNodeLabel(node)}`];

    if (node.warnings) {
        lines.push(`${indent}   Warnings: ${node.warnings}`);
    }

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function renderMsSqlExplainPlan(plan: MsSqlExplainPlan): string {
    const lines = flattenExplainText(plan.root);
    return lines.join('\n');
}

export function buildMsSqlExplainQuery(sql: string): string {
    return `SET SHOWPLAN_ALL ON;\n${sql.trim()};\nSET SHOWPLAN_ALL OFF;`;
}
