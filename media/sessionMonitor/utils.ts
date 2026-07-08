import type { SessionMonitorScalar } from './hostContracts.js';

export function escapeHtml(str: string | null | undefined): string {
    if (!str) {
        return '';
    }
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) {
        return '';
    }
    try {
        return new Date(dateStr).toLocaleString();
    } catch {
        return dateStr;
    }
}

export function formatNumber(num: SessionMonitorScalar): string {
    if (num === null || num === undefined) {
        return '';
    }
    if (typeof num === 'number') {
        return num.toLocaleString();
    }
    return String(num);
}

export function formatCostInThousands(cost: SessionMonitorScalar): string {
    if (cost === null || cost === undefined) {
        return '';
    }
    if (typeof cost === 'number' || typeof cost === 'bigint') {
        return cost.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }
    if (typeof cost === 'string' && /^\d+$/.test(cost)) {
        return cost.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }
    return String(cost);
}

export function formatPercent(value: SessionMonitorScalar): string {
    if (value === null || value === undefined || value === '') {
        return '0';
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return '0';
    }
    return num.toFixed(1).replace(/\.0$/, '');
}

export function formatRefreshDate(value: string | null | undefined): string {
    if (!value) {
        return '—';
    }
    try {
        return new Date(value).toLocaleTimeString();
    } catch {
        return String(value);
    }
}

export function toInt(value: string, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

export function formatValue(val: SessionMonitorScalar): string {
    if (val === null || val === undefined) {
        return '';
    }
    if (typeof val === 'number') {
        return val.toLocaleString();
    }
    return escapeHtml(String(val));
}

export function getSkewClass(skew: number | null | undefined): string {
    if (skew === null || skew === undefined) {
        return 'skew-good';
    }
    if (skew < 10) {
        return 'skew-good';
    }
    if (skew < 30) {
        return 'skew-warn';
    }
    return 'skew-bad';
}
