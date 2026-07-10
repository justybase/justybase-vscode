import type { QueryExecutionStatus } from './hostContracts.js';

export interface DurationDisplay {
    text: string;
    className: string;
}

export interface StatusDisplay {
    iconClass: string;
    text: string;
    className: string;
}

const statusMap: Record<QueryExecutionStatus, StatusDisplay> = {
    success: { iconClass: 'codicon codicon-pass', text: 'Success', className: 'status-success' },
    error: { iconClass: 'codicon codicon-error', text: 'Error', className: 'status-error' },
    cancelled: { iconClass: 'codicon codicon-warning', text: 'Cancelled', className: 'status-cancelled' },
};

export function formatDuration(durationMs: number | undefined | null): DurationDisplay {
    if (durationMs === undefined || durationMs === null) {
        return { text: '', className: '' };
    }
    if (durationMs < 1000) {
        return { text: `${durationMs}ms`, className: 'duration-fast' };
    }
    const seconds = durationMs / 1000;
    if (seconds < 10) {
        return { text: `${seconds.toFixed(1)}s`, className: 'duration-medium' };
    }
    if (seconds < 60) {
        return { text: `${seconds.toFixed(1)}s`, className: 'duration-slow' };
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return { text: `${minutes}m ${secs}s`, className: 'duration-slow' };
}

export function getStatusInfo(status: QueryExecutionStatus | undefined): StatusDisplay {
    if (status && statusMap[status]) {
        return statusMap[status];
    }
    return statusMap.success;
}

export function renderStatusIndicator(statusInfo: StatusDisplay): string {
    return `<span class="status-indicator ${statusInfo.className}" title="${escapeHtml(statusInfo.text)}"><span class="status-dot"></span></span>`;
}

export function formatRowsAffected(rowsAffected: number | undefined | null): string {
    if (rowsAffected === undefined || rowsAffected === null) {
        return '';
    }
    if (rowsAffected === 0) {
        return '0 rows';
    }
    return `${rowsAffected.toLocaleString()} rows`;
}

export function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

export interface TimestampParts {
    time: string;
    date: string;
}

export function formatTimestampParts(timestamp: number): TimestampParts {
    const date = new Date(timestamp);
    return {
        time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        date: date.toLocaleDateString(),
    };
}

export function renderContextChips(
    parts: Array<{ label: string; value: string | undefined | null }>,
): string {
    return parts
        .filter((part): part is { label: string; value: string } => Boolean(part.value && part.value.trim()))
        .map(part => `<span class="ctx-chip" title="${escapeHtml(part.label)}">${escapeHtml(part.value.trim())}</span>`)
        .join('');
}

export function escapeHtml(text: string | number | null | undefined): string {
    if (text === null || text === undefined || text === '') {
        return '';
    }
    const stringValue = typeof text === 'string' ? text : String(text);
    return stringValue
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const htmlEntityPattern = /&#(\d+);|&amp;|&lt;|&gt;|&quot;|&#x([0-9a-f]+);/gi;

export function decodeHtmlEntities(value: string): string {
    return value.replace(htmlEntityPattern, (match, num, hex) => {
        if (num !== undefined) {
            return String.fromCharCode(parseInt(num, 10));
        }
        if (hex !== undefined) {
            return String.fromCharCode(parseInt(hex, 16));
        }
        if (match === '&amp;') return '&';
        if (match === '&lt;') return '<';
        if (match === '&gt;') return '>';
        if (match === '&quot;') return '"';
        return match;
    });
}

export function gridSqlPreview(query: string, maxLen: number): string {
    if (!query) {
        return '';
    }
    const cleaned = decodeHtmlEntities(query).trim().replace(/\s+/g, ' ');
    if (cleaned.length <= maxLen) {
        return cleaned;
    }
    return `${cleaned.substring(0, maxLen)}...`;
}

export function buildContextLine(parts: Array<string | undefined | null>): string {
    return parts
        .filter((part): part is string => Boolean(part && part.trim()))
        .map(part => escapeHtml(part.trim()))
        .join('<span class="context-sep">·</span>');
}
