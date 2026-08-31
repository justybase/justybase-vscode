import * as logger from '../utils/logger';

export interface ResultPanelTraceEventPayload {
    phase: string;
    sourceUri?: string;
    command?: string;
    resultSetIndex?: number;
    resultSetCount?: number;
    rowCount?: number;
    totalRows?: number;
    isLog?: boolean;
    isFirstChunk?: boolean;
    isLastChunk?: boolean;
    visible?: boolean;
    ready?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    scrollTop?: number;
    scrollLeft?: number;
    scrollAnchorIndex?: number;
    firstVisibleRowIndex?: number;
    reason?: string;
    delivered?: boolean;
    error?: string;
    webviewSeq?: number;
}

export interface ResultPanelTraceRecord extends ResultPanelTraceEventPayload {
    seq: number;
    at: string;
    origin: 'host' | 'webview';
}

// Keep enough history for a complete Extension Host scenario. The payload is
// still bounded and contains only command/phase metadata, never SQL or rows.
const MAX_TRACE_EVENTS = 2_000;
const MAX_TRACE_TEXT_LENGTH = 256;
let traceSequence = 0;
let traceStart = 0;
let traceCount = 0;
const traceEvents: Array<ResultPanelTraceRecord | undefined> = [];

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
        ? value as Record<string, unknown>
        : undefined;
}

function boundedText(value: unknown): string | undefined {
    return typeof value === 'string'
        ? value.slice(0, MAX_TRACE_TEXT_LENGTH)
        : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/** Copy only the deliberately supported fields from an untrusted webview event. */
export function sanitizeResultPanelTraceEvent(value: unknown): ResultPanelTraceEventPayload {
    const input = asRecord(value);
    const event: ResultPanelTraceEventPayload = {
        phase: boundedText(input?.phase) ?? 'unknown',
    };
    const stringFields = ['sourceUri', 'command', 'reason'] as const;
    for (const field of stringFields) {
        const text = boundedText(input?.[field]);
        if (text !== undefined) {
            event[field] = text;
        }
    }
    const numberFields = [
        'resultSetIndex',
        'resultSetCount',
        'rowCount',
        'totalRows',
        'viewportWidth',
        'viewportHeight',
        'scrollTop',
        'scrollLeft',
        'scrollAnchorIndex',
        'firstVisibleRowIndex',
        'webviewSeq',
    ] as const;
    for (const field of numberFields) {
        const number = finiteNumber(input?.[field]);
        if (number !== undefined) {
            event[field] = number;
        }
    }
    const booleanFields = [
        'isLog',
        'isFirstChunk',
        'isLastChunk',
        'visible',
        'ready',
        'delivered',
    ] as const;
    for (const field of booleanFields) {
        const boolean = optionalBoolean(input?.[field]);
        if (boolean !== undefined) {
            event[field] = boolean;
        }
    }
    return event;
}

export function isResultPanelTraceEnabled(): boolean {
    return process.env.JUSTYBASE_RESULT_PANEL_TRACE === '1';
}

export function traceResultPanelEvent(
    event: ResultPanelTraceEventPayload,
    origin: ResultPanelTraceRecord['origin'] = 'host',
): void {
    if (!isResultPanelTraceEnabled()) {
        return;
    }

    const record: ResultPanelTraceRecord = {
        ...sanitizeResultPanelTraceEvent(event),
        seq: ++traceSequence,
        at: new Date().toISOString(),
        origin,
    };
    if (traceCount < MAX_TRACE_EVENTS) {
        traceEvents.push(record);
        traceCount += 1;
    } else {
        traceEvents[traceStart] = record;
        traceStart = (traceStart + 1) % MAX_TRACE_EVENTS;
    }

    const logWithFallback = (logger as typeof logger & {
        logWithFallback?: (level: 'info', message: string) => void;
    }).logWithFallback;
    logWithFallback?.('info', `[ResultPanelTrace] ${JSON.stringify(record)}`);
}

export function getResultPanelTraceSnapshot(): readonly ResultPanelTraceRecord[] {
    const snapshot: ResultPanelTraceRecord[] = [];
    for (let index = 0; index < traceCount; index += 1) {
        const event = traceEvents[(traceStart + index) % MAX_TRACE_EVENTS];
        if (event) {
            snapshot.push({ ...event });
        }
    }
    return snapshot;
}

export function clearResultPanelTrace(): void {
    traceEvents.length = 0;
    traceStart = 0;
    traceCount = 0;
    traceSequence = 0;
}
