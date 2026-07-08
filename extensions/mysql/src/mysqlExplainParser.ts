import { clampConfidence } from '../../../src/services/tuning/types';

export interface MysqlExplainNode {
    id: number;
    nodeType: string;
    tableName?: string;
    accessType?: string;
    indexName?: string;
    possibleKeys: string[];
    rowsExaminedPerScan: number;
    rowsProducedPerJoin: number;
    filtered?: number;
    costStart: number;
    costEnd: number;
    width: number;
    confidence: number;
    filter?: string;
    usingTemporaryTable?: boolean;
    usingFilesort?: boolean;
    message?: string;
    detail?: string;
    actualRows?: number;
    actualFirstRowTimeMs?: number;
    actualTotalTimeMs?: number;
    loops?: number;
    children: MysqlExplainNode[];
    raw: Record<string, unknown>;
}

export interface MysqlExplainPlan {
    root: MysqlExplainNode;
    format: 'json-v1' | 'json-v2' | 'tree';
}

interface NormalizedCostInfo {
    readCost?: number;
    endCost?: number;
    dataReadPerJoin?: string;
}

interface ParsedOperationLabel {
    nodeType: string;
    tableName?: string;
    indexName?: string;
    filter?: string;
    detail?: string;
    accessType?: string;
}

interface MysqlTreeNode extends MysqlExplainNode {
    depth: number;
}

const MYSQL_TREE_NODE_REGEX =
    /^\s*(?:EXPLAIN:\s*)?->\s*(.+?)(?:\s+\(cost=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+rows=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\))?(?:\s+\(actual time=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\.\.([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+rows=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+loops=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\))?\s*$/i;
const MYSQL_TREE_ACTUAL_REGEX =
    /^\s*\(actual time=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\.\.([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+rows=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+loops=([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\)\s*$/i;
const MYSQL_JSON_V1_ROOT_KEYS = [
    'query_block',
    'union_result',
    'ordering_operation',
    'grouping_operation',
    'duplicates_removal',
    'buffer_result',
    'windowing',
    'nested_loop',
    'table',
    'materialized_from_subquery',
] as const;

function toFiniteNumber(value: unknown): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'bigint') {
        return Number(value);
    }

    if (typeof value === 'string') {
        const normalized = value.replace(/,/g, '').trim();
        if (!normalized) {
            return 0;
        }

        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = toFiniteNumber(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value !== 0;
    }

    if (typeof value === 'string') {
        return /^(?:true|1|yes)$/i.test(value.trim());
    }

    return false;
}

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0);
    }

    if (typeof value === 'string') {
        return value
            .split(/\s*,\s*/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    return [];
}

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function unwrapMysqlExplainPayload(value: unknown): unknown {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed = tryParseJson(trimmed);
            return parsed ?? value;
        }
        return value;
    }

    if (Array.isArray(value)) {
        if (value.length === 1) {
            return unwrapMysqlExplainPayload(value[0]);
        }
        return value;
    }

    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of ['EXPLAIN', 'explain']) {
            if (record[key] !== undefined) {
                return unwrapMysqlExplainPayload(record[key]);
            }
        }
    }

    return value;
}

function normalizeMysqlJsonEnvelope(input: string | unknown): Record<string, unknown> {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    const unwrapped = unwrapMysqlExplainPayload(parsed);

    if (Array.isArray(unwrapped)) {
        if (unwrapped.length === 0) {
            throw new Error('MySQL EXPLAIN JSON payload is empty.');
        }
        return normalizeMysqlJsonEnvelope(unwrapped[0]);
    }

    if (unwrapped && typeof unwrapped === 'object') {
        return unwrapped as Record<string, unknown>;
    }

    throw new Error('Unsupported MySQL EXPLAIN JSON payload.');
}

function isMysqlJsonV1Record(record: Record<string, unknown>): boolean {
    return MYSQL_JSON_V1_ROOT_KEYS.some((key) => key in record);
}

function titleize(value: string): string {
    return value
        .trim()
        .replace(/[\s_]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function normalizeIdentifier(identifier: string): string {
    return identifier.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function parseHumanBytes(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.trim().replace(/\s+/g, '').toUpperCase();
    const match = normalized.match(/^([-+]?\d*\.?\d+)([KMGTP]?B?)?$/);
    if (!match) {
        return undefined;
    }

    const numericValue = Number(match[1]);
    if (!Number.isFinite(numericValue)) {
        return undefined;
    }

    const unit = match[2] || '';
    const multiplier = (() => {
        switch (unit.replace(/B$/, '')) {
            case 'K':
                return 1024;
            case 'M':
                return 1024 ** 2;
            case 'G':
                return 1024 ** 3;
            case 'T':
                return 1024 ** 4;
            case 'P':
                return 1024 ** 5;
            default:
                return 1;
        }
    })();

    return numericValue * multiplier;
}

function deriveWidth(
    rows: number,
    dataReadPerJoin: string | undefined,
    usedColumnsCount: number,
    childWidth: number,
): number {
    if (rows > 0) {
        const parsedBytes = parseHumanBytes(dataReadPerJoin);
        if (parsedBytes !== undefined && parsedBytes > 0) {
            return Math.max(1, Math.round(parsedBytes / rows));
        }
    }

    if (childWidth > 0) {
        return childWidth;
    }

    if (usedColumnsCount > 0) {
        return Math.max(1, usedColumnsCount * 8);
    }

    return 0;
}

function computeConfidence(plannedRows: number, actualRows?: number): number {
    if (actualRows === undefined || plannedRows <= 0) {
        return 1;
    }

    const larger = Math.max(actualRows, plannedRows);
    const smaller = Math.max(1, Math.min(actualRows, plannedRows));
    return clampConfidence(1 / (1 + Math.abs(Math.log10(larger / smaller))));
}

function maxChildCost(nodes: readonly MysqlExplainNode[]): number {
    return nodes.reduce((maxCost, node) => Math.max(maxCost, node.costEnd), 0);
}

function minChildCost(nodes: readonly MysqlExplainNode[]): number {
    if (nodes.length === 0) {
        return 0;
    }

    return nodes.reduce((minCost, node) => Math.min(minCost, node.costStart), nodes[0]?.costStart ?? 0);
}

function maxChildWidth(nodes: readonly MysqlExplainNode[]): number {
    return nodes.reduce((maxWidth, node) => Math.max(maxWidth, node.width), 0);
}

function maxChildRows(nodes: readonly MysqlExplainNode[]): number {
    return nodes.reduce(
        (maxRowsValue, node) => Math.max(maxRowsValue, node.rowsProducedPerJoin, node.rowsExaminedPerScan),
        0,
    );
}

function getRenderedRows(node: MysqlExplainNode): number {
    return Math.max(node.rowsProducedPerJoin, node.rowsExaminedPerScan);
}

function getNormalizedCostInfo(record: Record<string, unknown>): NormalizedCostInfo {
    const costInfoSource =
        record.cost_info && typeof record.cost_info === 'object'
            ? (record.cost_info as Record<string, unknown>)
            : undefined;

    const readCost =
        toOptionalNumber(costInfoSource?.read_cost)
        ?? toOptionalNumber(costInfoSource?.readCost)
        ?? toOptionalNumber(record.read_cost)
        ?? toOptionalNumber(record.readCost);
    const endCost =
        toOptionalNumber(costInfoSource?.query_cost)
        ?? toOptionalNumber(costInfoSource?.prefix_cost)
        ?? toOptionalNumber(costInfoSource?.queryCost)
        ?? toOptionalNumber(costInfoSource?.prefixCost)
        ?? toOptionalNumber(record.estimated_total_cost)
        ?? toOptionalNumber(record.query_cost)
        ?? toOptionalNumber(record.prefix_cost);
    const dataReadPerJoin =
        toOptionalString(costInfoSource?.data_read_per_join)
        ?? toOptionalString(costInfoSource?.dataReadPerJoin)
        ?? toOptionalString(record.data_read_per_join)
        ?? toOptionalString(record.dataReadPerJoin);

    return {
        readCost,
        endCost,
        dataReadPerJoin,
    };
}

function getVersion1StructuralChild(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode | undefined {
    if (record.ordering_operation && typeof record.ordering_operation === 'object') {
        return buildVersion1WrapperNode('Sort', record.ordering_operation as Record<string, unknown>, nextId);
    }
    if (record.grouping_operation && typeof record.grouping_operation === 'object') {
        return buildVersion1WrapperNode('Aggregate', record.grouping_operation as Record<string, unknown>, nextId);
    }
    if (record.duplicates_removal && typeof record.duplicates_removal === 'object') {
        return buildVersion1WrapperNode('Duplicate removal', record.duplicates_removal as Record<string, unknown>, nextId);
    }
    if (record.buffer_result && typeof record.buffer_result === 'object') {
        return buildVersion1WrapperNode('Buffer result', record.buffer_result as Record<string, unknown>, nextId);
    }
    if (record.windowing && typeof record.windowing === 'object') {
        return buildVersion1WrapperNode('Window', record.windowing as Record<string, unknown>, nextId);
    }
    if (record.union_result && typeof record.union_result === 'object') {
        return buildVersion1WrapperNode('Union result', record.union_result as Record<string, unknown>, nextId);
    }
    if (record.materialized_from_subquery && typeof record.materialized_from_subquery === 'object') {
        return buildVersion1WrapperNode(
            'Materialize',
            record.materialized_from_subquery as Record<string, unknown>,
            nextId,
        );
    }
    if (Array.isArray(record.nested_loop)) {
        return buildVersion1NestedLoopNode(record, nextId);
    }
    if (record.table && typeof record.table === 'object') {
        return buildVersion1TableNode(record.table as Record<string, unknown>, nextId);
    }
    if (record.query_block && typeof record.query_block === 'object') {
        return buildVersion1QueryBlockNode(record.query_block as Record<string, unknown>, nextId);
    }

    return undefined;
}

function collectVersion1SupplementalChildren(
    record: Record<string, unknown>,
    nextId: () => number,
    excludedKeys: readonly string[] = [],
): MysqlExplainNode[] {
    const excluded = new Set(excludedKeys);
    const nodes: MysqlExplainNode[] = [];

    const maybePushNode = (value: unknown): void => {
        if (value && typeof value === 'object') {
            nodes.push(buildVersion1Node(value as Record<string, unknown>, nextId));
        }
    };

    if (!excluded.has('attached_subqueries') && Array.isArray(record.attached_subqueries)) {
        for (const child of record.attached_subqueries) {
            maybePushNode(child);
        }
    }

    if (!excluded.has('optimized_away_subqueries') && Array.isArray(record.optimized_away_subqueries)) {
        for (const child of record.optimized_away_subqueries) {
            maybePushNode(child);
        }
    }

    if (!excluded.has('query_specifications') && Array.isArray(record.query_specifications)) {
        for (const child of record.query_specifications) {
            maybePushNode(child);
        }
    }

    return nodes;
}

function buildVersion1QueryBlockNode(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode {
    const structuralNode = getVersion1StructuralChild(record, nextId);
    if (structuralNode) {
        const queryCost = getNormalizedCostInfo(record).endCost;
        if (queryCost !== undefined) {
            structuralNode.costEnd = Math.max(structuralNode.costEnd, queryCost);
        }
        return structuralNode;
    }

    const supplementalChildren = collectVersion1SupplementalChildren(record, nextId);
    const costInfo = getNormalizedCostInfo(record);
    const rows = maxChildRows(supplementalChildren);

    return {
        id: nextId(),
        nodeType: 'Query block',
        possibleKeys: [],
        rowsExaminedPerScan: rows,
        rowsProducedPerJoin: rows,
        costStart: costInfo.readCost ?? minChildCost(supplementalChildren),
        costEnd: costInfo.endCost ?? maxChildCost(supplementalChildren),
        width: maxChildWidth(supplementalChildren),
        confidence: 1,
        children: supplementalChildren,
        raw: record,
    };
}

function buildVersion1NestedLoopNode(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode {
    const loopItems = Array.isArray(record.nested_loop) ? record.nested_loop : [];
    const children = loopItems
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => buildVersion1Node(item, nextId));
    const supplementalChildren = collectVersion1SupplementalChildren(record, nextId, ['nested_loop']);
    const allChildren = [...children, ...supplementalChildren];
    const costInfo = getNormalizedCostInfo(record);
    const rows = children[children.length - 1]?.rowsProducedPerJoin ?? maxChildRows(allChildren);

    return {
        id: nextId(),
        nodeType: 'Nested loop',
        possibleKeys: [],
        rowsExaminedPerScan: rows,
        rowsProducedPerJoin: rows,
        costStart: costInfo.readCost ?? minChildCost(allChildren),
        costEnd: costInfo.endCost ?? maxChildCost(allChildren),
        width: maxChildWidth(allChildren),
        confidence: 1,
        children: allChildren,
        raw: record,
    };
}

function buildVersion1TableNode(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode {
    const costInfo = getNormalizedCostInfo(record);
    const accessType = toOptionalString(record.access_type);
    const rowsExamined = toFiniteNumber(record.rows_examined_per_scan);
    const rowsProduced = toOptionalNumber(record.rows_produced_per_join) ?? rowsExamined;
    const usedColumns = toStringArray(record.used_columns);
    const children = collectVersion1SupplementalChildren(record, nextId);
    const actualRows = toOptionalNumber(record.actual_rows);
    const detailParts = [
        toOptionalString(record.using_join_buffer),
        toStringArray(record.used_key_parts).length > 0
            ? `parts=${toStringArray(record.used_key_parts).join('+')}`
            : undefined,
        toOptionalString(record.message),
    ].filter((value): value is string => Boolean(value));

    return {
        id: nextId(),
        nodeType: nodeTypeFromAccessType(accessType, record),
        tableName: toOptionalString(record.table_name),
        accessType,
        indexName: toOptionalString(record.key),
        possibleKeys: toStringArray(record.possible_keys),
        rowsExaminedPerScan: rowsExamined,
        rowsProducedPerJoin: rowsProduced,
        filtered: toOptionalNumber(record.filtered),
        costStart: costInfo.readCost ?? minChildCost(children),
        costEnd: costInfo.endCost ?? maxChildCost(children),
        width: deriveWidth(rowsProduced, costInfo.dataReadPerJoin, usedColumns.length, maxChildWidth(children)),
        confidence: computeConfidence(rowsProduced, actualRows),
        filter: toOptionalString(record.attached_condition),
        usingTemporaryTable: toBoolean(record.using_temporary_table),
        usingFilesort: toBoolean(record.using_filesort),
        message: toOptionalString(record.message),
        detail: detailParts.length > 0 ? detailParts.join(', ') : undefined,
        actualRows,
        children,
        raw: record,
    };
}

function buildVersion1WrapperNode(
    nodeType: string,
    record: Record<string, unknown>,
    nextId: () => number,
): MysqlExplainNode {
    const structuralNode = getVersion1StructuralChild(record, nextId);
    const supplementalChildren = collectVersion1SupplementalChildren(record, nextId);
    const children = [
        ...(structuralNode ? [structuralNode] : []),
        ...supplementalChildren,
    ];
    const costInfo = getNormalizedCostInfo(record);
    const rows = structuralNode?.rowsProducedPerJoin ?? maxChildRows(children);
    const usedColumns = toStringArray(record.used_columns);
    const actualRows = toOptionalNumber(record.actual_rows);
    const detailParts = [
        toBoolean(record.using_temporary_table) ? 'temporary table' : undefined,
        toBoolean(record.using_filesort) ? 'filesort' : undefined,
        toOptionalString(record.message),
    ].filter((value): value is string => Boolean(value));

    return {
        id: nextId(),
        nodeType,
        accessType: toOptionalString(record.access_type),
        indexName: toOptionalString(record.key),
        possibleKeys: toStringArray(record.possible_keys),
        rowsExaminedPerScan: toOptionalNumber(record.rows_examined_per_scan) ?? rows,
        rowsProducedPerJoin: rows,
        filtered: toOptionalNumber(record.filtered),
        costStart: costInfo.readCost ?? minChildCost(children),
        costEnd: costInfo.endCost ?? maxChildCost(children),
        width: deriveWidth(rows, costInfo.dataReadPerJoin, usedColumns.length, maxChildWidth(children)),
        confidence: computeConfidence(rows, actualRows),
        filter: toOptionalString(record.attached_condition) ?? toOptionalString(record.condition),
        usingTemporaryTable: toBoolean(record.using_temporary_table),
        usingFilesort: toBoolean(record.using_filesort),
        message: toOptionalString(record.message),
        detail: detailParts.length > 0 ? detailParts.join(', ') : undefined,
        actualRows,
        children,
        raw: record,
    };
}

function buildVersion1Node(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode {
    if (record.query_block && typeof record.query_block === 'object') {
        return buildVersion1QueryBlockNode(record.query_block as Record<string, unknown>, nextId);
    }

    const structuralNode = getVersion1StructuralChild(record, nextId);
    if (structuralNode) {
        return structuralNode;
    }

    return buildVersion1WrapperNode('Operation', record, nextId);
}

function normalizeOperationType(rawType: string): Pick<ParsedOperationLabel, 'nodeType' | 'detail'> {
    const trimmed = rawType.trim();

    const hashJoinMatch = trimmed.match(/^(inner|left|right|semi|anti|outer)?\s*hash join$/i);
    if (hashJoinMatch) {
        return {
            nodeType: 'Hash join',
            detail: hashJoinMatch[1] ? `${titleize(hashJoinMatch[1])} join` : undefined,
        };
    }

    const nestedLoopMatch = trimmed.match(/^(inner|left|right|semi|anti|outer)?\s*nested loop(?:\s+join)?$/i);
    if (nestedLoopMatch) {
        return {
            nodeType: 'Nested loop',
            detail: nestedLoopMatch[1] ? `${titleize(nestedLoopMatch[1])} join` : undefined,
        };
    }

    return {
        nodeType: titleize(trimmed),
    };
}

function parseOperationLabel(
    operationText: string | undefined,
    fallbackTableName?: string,
    fallbackIndexName?: string,
): ParsedOperationLabel {
    const normalizedOperation = operationText?.trim();
    if (!normalizedOperation) {
        return {
            nodeType: fallbackTableName ? 'Table access' : 'Operation',
            tableName: fallbackTableName,
            indexName: fallbackIndexName,
        };
    }

    const filterMatch = normalizedOperation.match(/^Filter:\s*(.+)$/i);
    if (filterMatch) {
        return {
            nodeType: 'Filter',
            tableName: fallbackTableName,
            indexName: fallbackIndexName,
            filter: filterMatch[1].trim(),
        };
    }

    const onMatch = normalizedOperation.match(/^(.*?)\s+on\s+(.+?)(?:\s+using\s+([^\s(]+)(.*))?$/i);
    if (onMatch) {
        const [, rawType, rawTable, rawIndex, trailingDetail] = onMatch;
        const normalizedType = normalizeOperationType(rawType);
        const detail = trailingDetail?.trim();
        return {
            nodeType: normalizedType.nodeType,
            tableName: normalizeIdentifier(rawTable),
            indexName: rawIndex ? normalizeIdentifier(rawIndex) : fallbackIndexName,
            detail: [normalizedType.detail, detail && detail.length > 0 ? detail : undefined]
                .filter((value): value is string => Boolean(value))
                .join(', ') || undefined,
        };
    }

    const normalizedType = normalizeOperationType(normalizedOperation);
    return {
        nodeType: normalizedType.nodeType,
        tableName: fallbackTableName,
        indexName: fallbackIndexName,
        detail: normalizedType.detail,
    };
}

function buildVersion2Node(record: Record<string, unknown>, nextId: () => number): MysqlExplainNode {
    const costInfo = getNormalizedCostInfo(record);
    const childNodes = Array.isArray(record.inputs)
        ? record.inputs
              .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
              .map((child) => buildVersion2Node(child, nextId))
        : [];
    const operation = parseOperationLabel(
        toOptionalString(record.operation),
        toOptionalString(record.table_name),
        toOptionalString(record.index_name),
    );
    const estimatedRows =
        toOptionalNumber(record.estimated_rows)
        ?? toOptionalNumber(record.rows_produced_per_join)
        ?? toOptionalNumber(record.rows_examined_per_scan)
        ?? maxChildRows(childNodes);
    const usedColumns = toStringArray(record.used_columns);
    const actualRows = toOptionalNumber(record.actual_rows);

    return {
        id: nextId(),
        nodeType: operation.nodeType,
        tableName: operation.tableName,
        accessType: toOptionalString(record.access_type) ?? operation.accessType,
        indexName: operation.indexName,
        possibleKeys: toStringArray(record.possible_keys),
        rowsExaminedPerScan: toOptionalNumber(record.rows_examined_per_scan) ?? estimatedRows,
        rowsProducedPerJoin: estimatedRows,
        filtered: toOptionalNumber(record.filtered),
        costStart: costInfo.readCost ?? minChildCost(childNodes),
        costEnd: costInfo.endCost ?? maxChildCost(childNodes),
        width: deriveWidth(estimatedRows, costInfo.dataReadPerJoin, usedColumns.length, maxChildWidth(childNodes)),
        confidence: computeConfidence(estimatedRows, actualRows),
        filter: operation.filter ?? toOptionalString(record.condition),
        usingTemporaryTable: toBoolean(record.using_temporary_table),
        usingFilesort: toBoolean(record.using_filesort),
        message: toOptionalString(record.message),
        detail: operation.detail,
        actualRows,
        actualFirstRowTimeMs: toOptionalNumber(record.actual_first_row_time_ms),
        actualTotalTimeMs: toOptionalNumber(record.actual_total_time_ms),
        loops: toOptionalNumber(record.loops),
        children: childNodes,
        raw: record,
    };
}

function finalizeTreeNode(node: MysqlTreeNode): MysqlExplainNode {
    const children = node.children.map((child) => finalizeTreeNode(child as MysqlTreeNode));
    const rows = node.rowsProducedPerJoin > 0 ? node.rowsProducedPerJoin : maxChildRows(children);
    const costEnd = node.costEnd > 0 ? node.costEnd : maxChildCost(children);
    const costStart = node.costStart > 0 ? node.costStart : (children.length > 0 ? minChildCost(children) : 0);
    const width = node.width > 0 ? node.width : maxChildWidth(children);
    const confidence = computeConfidence(rows, node.actualRows);

    return {
        ...node,
        rowsExaminedPerScan: node.rowsExaminedPerScan > 0 ? node.rowsExaminedPerScan : rows,
        rowsProducedPerJoin: rows,
        costStart,
        costEnd,
        width,
        confidence,
        children,
    };
}

function parseMysqlTreeLabel(line: string): ParsedOperationLabel | undefined {
    const match = line.match(MYSQL_TREE_NODE_REGEX);
    if (!match) {
        return undefined;
    }

    return parseOperationLabel(match[1]);
}

function nodeTypeFromAccessType(accessType: string | undefined, record?: Record<string, unknown>): string {
    const normalized = accessType?.trim().toLowerCase();
    switch (normalized) {
        case 'all':
            return 'Table scan';
        case 'index':
            return toBoolean(record?.using_index) ? 'Covering index scan' : 'Index scan';
        case 'range':
            return 'Index range scan';
        case 'ref':
        case 'eq_ref':
        case 'const':
        case 'system':
        case 'ref_or_null':
            return 'Index lookup';
        case 'index_merge':
            return 'Index merge';
        case 'fulltext':
            return 'Fulltext search';
        case 'unique_subquery':
            return 'Unique subquery';
        case 'index_subquery':
            return 'Index subquery';
        default:
            return normalized ? titleize(normalized) : 'Table access';
    }
}

export function isMysqlExplainJson(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return false;
    }

    try {
        const envelope = normalizeMysqlJsonEnvelope(trimmed);
        return isMysqlJsonV1Record(envelope) || Array.isArray(envelope.inputs) || typeof envelope.operation === 'string';
    } catch {
        return false;
    }
}

export function isMysqlExplainText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }

    return /(?:^|\n)\s*(?:EXPLAIN:\s*)?->\s+.+?(?:\n\s*\(actual time=|\s+\(cost=)/i.test(trimmed);
}

export function parseMysqlExplainJson(input: string | unknown): MysqlExplainPlan {
    const envelope = normalizeMysqlJsonEnvelope(input);
    const format: MysqlExplainPlan['format'] = isMysqlJsonV1Record(envelope) ? 'json-v1' : 'json-v2';

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    return {
        root: format === 'json-v1' ? buildVersion1Node(envelope, nextId) : buildVersion2Node(envelope, nextId),
        format,
    };
}

export function parseMysqlExplainText(text: string): MysqlExplainPlan {
    const lines = text
        .split('\n')
        .map((line) => line.replace(/^\s*EXPLAIN:\s*/, ''))
        .filter((line) => line.trim().length > 0);

    let currentId = 0;
    const nextId = (): number => {
        currentId += 1;
        return currentId;
    };

    const rootNodes: MysqlTreeNode[] = [];
    const stack: MysqlTreeNode[] = [];
    let lastNode: MysqlTreeNode | undefined;

    for (const line of lines) {
        const actualMatch = line.match(MYSQL_TREE_ACTUAL_REGEX);
        if (actualMatch && lastNode) {
            lastNode.actualFirstRowTimeMs = toOptionalNumber(actualMatch[1]);
            lastNode.actualTotalTimeMs = toOptionalNumber(actualMatch[2]);
            lastNode.actualRows = toOptionalNumber(actualMatch[3]);
            lastNode.loops = toOptionalNumber(actualMatch[4]);
            continue;
        }

        const label = parseMysqlTreeLabel(line);
        const match = line.match(MYSQL_TREE_NODE_REGEX);
        if (!label || !match) {
            continue;
        }

        const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
        const depth = Math.max(0, Math.floor(leadingSpaces / 4));
        const estimatedRows = toOptionalNumber(match[3]) ?? 0;

        const node: MysqlTreeNode = {
            id: nextId(),
            depth,
            nodeType: label.nodeType,
            tableName: label.tableName,
            accessType: label.accessType,
            indexName: label.indexName,
            possibleKeys: [],
            rowsExaminedPerScan: estimatedRows,
            rowsProducedPerJoin: estimatedRows,
            costStart: 0,
            costEnd: toOptionalNumber(match[2]) ?? 0,
            width: 0,
            confidence: 1,
            filter: label.filter,
            detail: label.detail,
            actualFirstRowTimeMs: toOptionalNumber(match[4]),
            actualTotalTimeMs: toOptionalNumber(match[5]),
            actualRows: toOptionalNumber(match[6]),
            loops: toOptionalNumber(match[7]),
            children: [],
            raw: { label: match[1] },
        };

        while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
            stack.pop();
        }

        const parent = stack[stack.length - 1];
        if (parent) {
            parent.children.push(node);
        } else {
            rootNodes.push(node);
        }

        stack.push(node);
        lastNode = node;
    }

    if (rootNodes.length === 0) {
        throw new Error('MySQL EXPLAIN text did not contain any TREE/ANALYZE nodes.');
    }

    const root = rootNodes.length === 1
        ? finalizeTreeNode(rootNodes[0])
        : finalizeTreeNode({
              id: nextId(),
              depth: 0,
              nodeType: 'Query',
              possibleKeys: [],
              rowsExaminedPerScan: maxChildRows(rootNodes),
              rowsProducedPerJoin: maxChildRows(rootNodes),
              costStart: 0,
              costEnd: maxChildCost(rootNodes),
              width: maxChildWidth(rootNodes),
              confidence: 1,
              children: rootNodes,
              raw: { source: 'tree' },
          });

    return {
        root,
        format: 'tree',
    };
}

export function parseMysqlExplainPlan(input: string | unknown): MysqlExplainPlan {
    if (typeof input === 'string') {
        if (isMysqlExplainJson(input)) {
            return parseMysqlExplainJson(input);
        }
        if (isMysqlExplainText(input)) {
            return parseMysqlExplainText(input);
        }
        throw new Error('Unsupported MySQL EXPLAIN payload.');
    }

    return parseMysqlExplainJson(input);
}

function formatExplainNodeLabel(node: MysqlExplainNode): string {
    const relationSuffix = node.tableName ? ` table "${node.tableName}"` : '';
    const detailSuffix = [
        node.accessType ? node.accessType.toUpperCase() : undefined,
        node.indexName ? `key=${node.indexName}` : undefined,
        node.usingTemporaryTable ? 'temporary' : undefined,
        node.usingFilesort ? 'filesort' : undefined,
        node.detail,
    ]
        .filter((value): value is string => Boolean(value))
        .join(', ');
    const details = detailSuffix ? ` {${detailSuffix}}` : '';

    return `${node.nodeType}${relationSuffix}${details} (cost=${node.costStart.toFixed(2)}..${node.costEnd.toFixed(2)} rows=${Math.round(getRenderedRows(node))} width=${Math.round(node.width)} conf=${node.confidence.toFixed(2)})`;
}

function flattenExplainText(node: MysqlExplainNode, depth = 0): string[] {
    const indent = depth > 0 ? ' '.repeat(depth * 3) : '';
    const lines = [`${indent}${formatExplainNodeLabel(node)}`];

    if (node.filter) {
        lines.push(`${indent}   Filter: ${node.filter}`);
    }
    if (node.indexName) {
        lines.push(`${indent}   Index: ${node.indexName}`);
    }
    if (node.actualTotalTimeMs !== undefined || node.actualRows !== undefined || node.loops !== undefined) {
        const metrics = [
            node.actualFirstRowTimeMs !== undefined ? `firstRow=${node.actualFirstRowTimeMs.toFixed(3)} ms` : undefined,
            node.actualTotalTimeMs !== undefined ? `total=${node.actualTotalTimeMs.toFixed(3)} ms` : undefined,
            node.actualRows !== undefined ? `rows=${Math.round(node.actualRows).toLocaleString()}` : undefined,
            node.loops !== undefined ? `loops=${Math.round(node.loops).toLocaleString()}` : undefined,
        ].filter((value): value is string => Boolean(value));
        if (metrics.length > 0) {
            lines.push(`${indent}   Actual: ${metrics.join(', ')}`);
        }
    }
    if (node.message) {
        lines.push(`${indent}   Note: ${node.message}`);
    }

    for (const child of node.children) {
        lines.push(...flattenExplainText(child, depth + 1));
    }

    return lines;
}

export function renderMysqlExplainPlan(plan: MysqlExplainPlan): string {
    return flattenExplainText(plan.root).join('\n');
}

export function buildMysqlExplainQuery(
    sql: string,
    options: {
        analyze?: boolean;
        verbose?: boolean;
    } = {},
): string {
    const statement = sql.trim();
    if (options.analyze) {
        return `EXPLAIN ANALYZE FORMAT=TREE ${statement}`;
    }

    return `EXPLAIN FORMAT=JSON ${statement}`;
}
