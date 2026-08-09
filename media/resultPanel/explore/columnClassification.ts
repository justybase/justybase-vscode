// Pure column-role classification for the Explore view.
// Classifies result-set columns as dimension / measure / date using type hints,
// name heuristics and a value sample (mirrors the approach of modern SQL IDEs).

import type { ExploreColumnRole } from './types.js';

const INTEGER_TYPE_NAMES = new Set([
    'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
    'serial', 'smallserial', 'bigserial',
    'int1', 'int2', 'int4', 'int8', 'int16', 'int32', 'int64',
    'byteint', 'uint8', 'uint16', 'uint32', 'uint64',
]);

const DECIMAL_TYPE_NAMES = new Set([
    'numeric', 'decimal', 'dec', 'number', 'fixed', 'float', 'real', 'double',
    'double precision', 'money', 'smallmoney',
]);

const TEMPORAL_TYPE_NAMES = new Set([
    'date', 'time', 'datetime', 'timestamp', 'timestamptz', 'datetime2',
    'datetimeoffset', 'smalldatetime', 'timestamp without time zone',
    'timestamp with time zone', 'time without time zone', 'time with time zone',
    'interval',
]);

const BOOLEAN_TYPE_NAMES = new Set(['bool', 'boolean', 'bit']);

/**
 * Suffixes that mark a column as an identifier/label even when numeric or
 * textual: e.g. CUSTOMER_ID, ORDER_CODE, STATUS_TYPE, IS_ACTIVE.
 */
const DIMENSION_NAME_MARKERS = [
    '_ID', '_CODE', '_TYPE', '_FLAG', '_NAME', '_KEY', '_NO', '_NUM',
    'ID', 'KEY', 'CODE', 'NAME', 'LABEL', 'DESC', 'DESCRIPTION', 'STATUS',
    'IS_', 'HAS_', 'FLAG',
];

export function extractBaseTypeName(type: string | undefined): string {
    if (!type) {
        return '';
    }
    return type.trim().toLowerCase().split('(')[0].trim();
}

export function isNumericType(type: string | undefined): boolean {
    const base = extractBaseTypeName(type);
    return INTEGER_TYPE_NAMES.has(base) || DECIMAL_TYPE_NAMES.has(base);
}

export function isTemporalType(type: string | undefined): boolean {
    return TEMPORAL_TYPE_NAMES.has(extractBaseTypeName(type));
}

export function isBooleanType(type: string | undefined): boolean {
    return BOOLEAN_TYPE_NAMES.has(extractBaseTypeName(type));
}

export function isLikelyDimensionName(name: string): boolean {
    const upper = (name || '').toUpperCase();
    return DIMENSION_NAME_MARKERS.some(marker => upper.includes(marker));
}

export function parseNumericValue(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'bigint') {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) ? asNumber : null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NULL') {
        return null;
    }
    const normalized = trimmed.replace(/\s/g, '').replace(/,/g, '');
    if (!/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(normalized)) {
        return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Ratio of non-null sample values that parse as numbers (0..1). */
function numericRatio(values: readonly unknown[]): number {
    let nonNull = 0;
    let numeric = 0;
    const sampleSize = Math.min(values.length, 200);
    for (let i = 0; i < sampleSize; i++) {
        const value = values[i];
        if (value === null || value === undefined || value === '') {
            continue;
        }
        nonNull += 1;
        if (parseNumericValue(value) !== null) {
            numeric += 1;
        }
    }
    if (nonNull === 0) {
        return 0;
    }
    return numeric / nonNull;
}

/** Distinct-count ratio of a sample; low cardinality suggests a dimension. */
function lowCardinality(values: readonly unknown[], maxDistinct = 50): boolean {
    const seen = new Set<string>();
    const sampleSize = Math.min(values.length, 500);
    for (let i = 0; i < sampleSize; i++) {
        const value = values[i];
        if (value === null || value === undefined || value === '') {
            continue;
        }
        seen.add(String(value));
        if (seen.size > maxDistinct) {
            return false;
        }
    }
    return seen.size > 0;
}

/**
 * Classify a column using its declared type, name and a value sample.
 *
 * Precedence: date type -> date; boolean -> dimension; numeric type ->
 * measure unless the name looks like an identifier; otherwise text heuristics
 * (low cardinality or identifier-like name -> dimension; numeric-heavy values
 * -> measure).
 */
export function classifyColumnRole(
    name: string,
    type: string | undefined,
    sampleValues: readonly unknown[],
): ExploreColumnRole {
    if (isTemporalType(type)) {
        return 'date';
    }
    if (isBooleanType(type)) {
        return 'dimension';
    }
    if (isNumericType(type)) {
        if (isLikelyDimensionName(name)) {
            return 'dimension';
        }
        return 'measure';
    }
    if (isLikelyDimensionName(name) || lowCardinality(sampleValues)) {
        return 'dimension';
    }
    if (numericRatio(sampleValues) >= 0.7) {
        return 'measure';
    }
    return 'dimension';
}

export function classifyColumns(
    columns: ReadonlyArray<{ name: string; type?: string }>,
    rows: readonly unknown[][],
): ExploreColumnRole[] {
    return columns.map((column, index) => {
        const sample: unknown[] = [];
        const sampleSize = Math.min(rows.length, 200);
        for (let i = 0; i < sampleSize; i++) {
            sample.push(rows[i]?.[index]);
        }
        return classifyColumnRole(column.name, column.type, sample);
    });
}
