const TEMPORAL_COLUMN_BASE_TYPES = new Set([
    'date',
    'time',
    'timetz',
    'timestamp',
    'timestamptz',
    'datetime',
    'datetime2',
    'datetimeoffset',
    'smalldatetime',
    'abstime',
    'reltime',
    'interval',
]);

function extractTemporalBaseType(dataType: string | undefined): string {
    return (dataType ?? '').trim().toLowerCase().split('(')[0]?.trim() ?? '';
}

export function isTemporalColumnType(dataType: string | undefined): boolean {
    const lower = (dataType ?? '').toLowerCase();
    const baseType = extractTemporalBaseType(dataType);
    return TEMPORAL_COLUMN_BASE_TYPES.has(baseType)
        || lower.includes('timestamp')
        || lower.includes('datetime');
}

function isEpochSecondTimestamp(value: number): boolean {
    return Number.isFinite(value) && value >= 1_000_000_000 && value < 10_000_000_000;
}

export function normalizeTemporalCellValue(value: unknown, dataType: string | undefined): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'number' && isTemporalColumnType(dataType) && isEpochSecondTimestamp(value)) {
        return new Date(value * 1000).toISOString();
    }
    if (typeof value === 'object' && value !== null && typeof (value as { toString?: () => string }).toString === 'function') {
        const rendered = String(value);
        if (rendered !== '[object Object]') {
            return rendered;
        }
    }
    return value;
}
