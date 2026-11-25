import { clampConfidence } from '@justybase/contracts';
import type { DatabaseExplainOptions, DatabaseExplainProvider } from '@justybase/contracts';

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
    /** Columns carried by the operator's data stream; 0 when unknown. */
    columnCount?: number;
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

function hasAnyKey(record: Record<string, unknown>, keys: string[]): boolean {
    return keys.some((key) => record[key] !== undefined);
}

const OPERATOR_ID_KEYS = ['OPERATOR_ID', 'operator_id', 'operatorId'];
const PARENT_ID_KEYS = ['PARENT_ID', 'parent_id', 'parentId'];

/**
 * `buildDb2ExplainRetrieveQuery` returns one flat row per `EXPLAIN_OPERATOR`
 * entry. That shape is not the nested plan used by the shared graph, so it is
 * recognised separately from a nested JSON envelope.
 */
export function isDb2ExplainOperatorRows(input: unknown): input is Record<string, unknown>[] {
    if (!Array.isArray(input) || input.length === 0) {
        return false;
    }

    const first = input[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
        return false;
    }

    const record = first as Record<string, unknown>;
    return hasAnyKey(record, OPERATOR_ID_KEYS)
        && hasAnyKey(record, ['operator_type', 'OPERATOR_TYPE', 'operatorType']);
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
        columnCount: toOptionalNumber(caseGet(record, 'column_count', 'COLUMN_COUNT', 'columnCount')),
        sortRequired: toOptionalBoolean(caseGet(record, 'sort_required', 'SORT_REQUIRED', 'sortRequired')),
        children: childRecords
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object' && !Array.isArray(child))
            .map((child) => buildNode(child, nextId)),
        raw: record,
    };
}

/**
 * Rebuilds the plan tree from flat EXPLAIN_OPERATOR rows. `PARENT_ID` comes
 * from the operator-to-operator stream in EXPLAIN_STREAM; when it is missing the
 * rows are attached under the most expensive operator so no node is lost.
 */
function buildPlanFromOperatorRows(rows: readonly Record<string, unknown>[]): Db2ExplainPlan {
    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const byOperatorId = new Map<number, Db2ExplainNode>();
    const parentByNodeId = new Map<number, number>();
    const ordered: Db2ExplainNode[] = [];

    for (const row of rows) {
        const node = buildNode(row, nextId);
        const operatorId = toOptionalNumber(caseGet(row, ...OPERATOR_ID_KEYS));
        const parentId = toOptionalNumber(caseGet(row, ...PARENT_ID_KEYS));
        if (operatorId !== undefined) {
            byOperatorId.set(operatorId, node);
        }
        if (parentId !== undefined) {
            parentByNodeId.set(node.id, parentId);
        }
        ordered.push(node);
    }

    const roots: Db2ExplainNode[] = [];
    for (const node of ordered) {
        const parentOperatorId = parentByNodeId.get(node.id);
        const parent = parentOperatorId !== undefined ? byOperatorId.get(parentOperatorId) : undefined;
        if (parent && parent !== node && !parent.children.includes(node)) {
            parent.children.push(node);
            continue;
        }
        roots.push(node);
    }

    if (roots.length === 0) {
        // Every node claimed a parent (a cycle): keep the first as the root.
        const [first, ...rest] = ordered;
        if (!first) {
            throw new Error('Unsupported Db2 EXPLAIN JSON payload: empty array.');
        }
        first.children.push(...rest);
        return { root: first, totalCost: first.totalCost };
    }

    const root = roots.reduce((best, node) => (node.totalCost > best.totalCost ? node : best));
    const extraRoots = roots.filter((node) => node !== root);
    if (extraRoots.length > 0) {
        root.children.push(...extraRoots);
    }

    return { root, totalCost: root.totalCost };
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
    let parsedInput = input;
    if (typeof input === 'string') {
        try {
            parsedInput = JSON.parse(input);
        } catch {
            throw new Error('Invalid JSON in Db2 EXPLAIN payload.');
        }
    }

    if (isDb2ExplainOperatorRows(parsedInput)) {
        return buildPlanFromOperatorRows(parsedInput);
    }

    const envelope = normalizeEnvelope(parsedInput);

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
    const objectSuffix = objectName ? ` table "${objectName}"` : '';
    const confidence =
        node.actualRows !== undefined && node.estimatedRows > 0
            ? clampConfidence(1 / (1 + Math.abs(Math.log10(Math.max(node.actualRows, 1) / Math.max(node.estimatedRows, 1)))))
            : 1;
    const width = node.columnCount ?? 0;

    // Keep the shared `(cost=A..B rows=N width=W conf=C)` shape so the common
    // Explain Plan webview can build its graph from Db2 output too. Db2 reports a
    // single total cost per operator, so both bounds carry the same value.
    return `${node.operatorType}${objectSuffix} (cost=${node.totalCost.toFixed(2)}..${node.totalCost.toFixed(2)} rows=${Math.round(node.estimatedRows)} width=${width} conf=${confidence.toFixed(2)})`;
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
    // OBJECT_SCHEMA/OBJECT_NAME belong to the data-object stream that feeds an
    // operator (SOURCE_ID = -1), while STREAM_COUNT/COLUMN_COUNT describe the
    // stream the operator produces. Using one join for both would leave every
    // join's cardinality at 0, so the two shapes are read separately with
    // scalar subqueries that always yield at most one value per operator.
    //
    // PARENT_ID comes from the operator-to-operator streams: the operator that
    // consumes this operator's output (TARGET_ID of a stream whose SOURCE_ID is
    // the current operator) is its parent in the plan tree.
    return `
        SELECT
            O.OPERATOR_ID,
            O.OPERATOR_TYPE,
            (
                SELECT MIN(D.OBJECT_SCHEMA)
                FROM EXPLAIN_STREAM D
                WHERE D.EXPLAIN_REQUESTER = O.EXPLAIN_REQUESTER
                  AND D.EXPLAIN_TIME = O.EXPLAIN_TIME
                  AND D.SOURCE_NAME = O.SOURCE_NAME
                  AND D.SOURCE_SCHEMA = O.SOURCE_SCHEMA
                  AND D.SOURCE_VERSION = O.SOURCE_VERSION
                  AND D.EXPLAIN_LEVEL = O.EXPLAIN_LEVEL
                  AND D.STMTNO = O.STMTNO
                  AND D.SECTNO = O.SECTNO
                  AND D.TARGET_ID = O.OPERATOR_ID
                  AND D.SOURCE_ID = -1
            ) AS OBJECT_SCHEMA,
            (
                SELECT MIN(D.OBJECT_NAME)
                FROM EXPLAIN_STREAM D
                WHERE D.EXPLAIN_REQUESTER = O.EXPLAIN_REQUESTER
                  AND D.EXPLAIN_TIME = O.EXPLAIN_TIME
                  AND D.SOURCE_NAME = O.SOURCE_NAME
                  AND D.SOURCE_SCHEMA = O.SOURCE_SCHEMA
                  AND D.SOURCE_VERSION = O.SOURCE_VERSION
                  AND D.EXPLAIN_LEVEL = O.EXPLAIN_LEVEL
                  AND D.STMTNO = O.STMTNO
                  AND D.SECTNO = O.SECTNO
                  AND D.TARGET_ID = O.OPERATOR_ID
                  AND D.SOURCE_ID = -1
            ) AS OBJECT_NAME,
            O.TOTAL_COST,
            (
                SELECT MIN(OUT.STREAM_COUNT)
                FROM EXPLAIN_STREAM OUT
                WHERE OUT.EXPLAIN_REQUESTER = O.EXPLAIN_REQUESTER
                  AND OUT.EXPLAIN_TIME = O.EXPLAIN_TIME
                  AND OUT.SOURCE_NAME = O.SOURCE_NAME
                  AND OUT.SOURCE_SCHEMA = O.SOURCE_SCHEMA
                  AND OUT.SOURCE_VERSION = O.SOURCE_VERSION
                  AND OUT.EXPLAIN_LEVEL = O.EXPLAIN_LEVEL
                  AND OUT.STMTNO = O.STMTNO
                  AND OUT.SECTNO = O.SECTNO
                  AND OUT.SOURCE_ID = O.OPERATOR_ID
                  AND OUT.SOURCE_TYPE = 'O'
            ) AS STREAM_COUNT,
            O.IO_COST,
            O.CPU_COST,
            (
                SELECT MIN(OUT.COLUMN_COUNT)
                FROM EXPLAIN_STREAM OUT
                WHERE OUT.EXPLAIN_REQUESTER = O.EXPLAIN_REQUESTER
                  AND OUT.EXPLAIN_TIME = O.EXPLAIN_TIME
                  AND OUT.SOURCE_NAME = O.SOURCE_NAME
                  AND OUT.SOURCE_SCHEMA = O.SOURCE_SCHEMA
                  AND OUT.SOURCE_VERSION = O.SOURCE_VERSION
                  AND OUT.EXPLAIN_LEVEL = O.EXPLAIN_LEVEL
                  AND OUT.STMTNO = O.STMTNO
                  AND OUT.SECTNO = O.SECTNO
                  AND OUT.SOURCE_ID = O.OPERATOR_ID
                  AND OUT.SOURCE_TYPE = 'O'
            ) AS COLUMN_COUNT,
            (
                SELECT MIN(P.TARGET_ID)
                FROM EXPLAIN_STREAM P
                WHERE P.EXPLAIN_REQUESTER = O.EXPLAIN_REQUESTER
                  AND P.EXPLAIN_TIME = O.EXPLAIN_TIME
                  AND P.SOURCE_NAME = O.SOURCE_NAME
                  AND P.SOURCE_SCHEMA = O.SOURCE_SCHEMA
                  AND P.SOURCE_VERSION = O.SOURCE_VERSION
                  AND P.EXPLAIN_LEVEL = O.EXPLAIN_LEVEL
                  AND P.STMTNO = O.STMTNO
                  AND P.SECTNO = O.SECTNO
                  AND P.SOURCE_ID = O.OPERATOR_ID
                  AND P.SOURCE_TYPE = 'O'
                  AND P.TARGET_TYPE = 'O'
            ) AS PARENT_ID
        FROM EXPLAIN_OPERATOR O
        WHERE O.EXPLAIN_REQUESTER = CURRENT USER
          AND O.EXPLAIN_TIME = (
              SELECT MAX(I.EXPLAIN_TIME)
              FROM EXPLAIN_INSTANCE I
              WHERE I.EXPLAIN_REQUESTER = CURRENT USER
          )
        ORDER BY O.OPERATOR_ID
    `;
}

/**
 * Db2 `EXPLAIN PLAN FOR` writes the plan into the EXPLAIN_* tables instead of
 * returning it, so the provider also supplies the retrieval statement. The
 * shared runner executes it on the same connection and hands the rows back as
 * JSON, which `normalizeOutput` turns into the shared plan-text shape used by
 * the Explain Plan webview and the tuning advisor.
 */
export const db2ExplainProvider: DatabaseExplainProvider = {
    buildQuery(sql: string, _options?: DatabaseExplainOptions): string {
        return buildDb2ExplainQuery(sql);
    },
    buildRetrieveQuery(): string {
        return buildDb2ExplainRetrieveQuery();
    },
    normalizeOutput(output: string): string {
        if (!isDb2ExplainJson(output)) {
            return output;
        }

        const plan = parseDb2ExplainJson(output);
        return renderDb2ExplainPlan(plan);
    },
    formatError(message: string): string | undefined {
        if (/SQL0219N|SQL0204N.*EXPLAIN_|EXPLAIN_OPERATOR|EXPLAIN_INSTANCE/i.test(message)) {
            return `${message}\n\nDb2 EXPLAIN needs its catalog tables. Run the EXPLAIN.DDL script from your Db2 instance (usually \`/opt/ibm/db2/V11.5/misc/EXPLAIN.DDL\`, or \`CALL SYSPROC.SYSINSTALLOBJECTS('EXPLAIN', 'C', ...)\` on older versions), then retry.`;
        }
        if (/SQL0551N|SQL0443N/i.test(message)) {
            return `${message}\n\nThe connected Db2 user must be able to write to the EXPLAIN tables and read EXPLAIN_OPERATOR / EXPLAIN_STREAM.`;
        }
        return undefined;
    },
};
