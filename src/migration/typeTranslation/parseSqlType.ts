/**
 * Parsing of SQL type strings into a normalized (base, precision, scale, length) shape.
 *
 * The normalized vocabulary follows the canonical import types shared by the
 * per-dialect importers (`BIGINT`, `NUMERIC(p,s)`, `NVARCHAR(n)`, `DATETIME`, ...).
 */

export interface ParsedSqlType {
    /** Normalized base type name without parameters, e.g. `NUMERIC`, `VARCHAR`. */
    base: string;
    precision?: number;
    scale?: number;
    length?: number;
    /** True for `TIMESTAMP WITH TIME ZONE` / `TIMESTAMP WITH LOCAL TIME ZONE`. */
    withTimeZone?: boolean;
    /** Raw type name normalized to upper case, e.g. `NUMERIC(18,2)`. */
    normalized: string;
}

export function normalizeSqlTypeName(typeName: string): string {
    return typeName.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function getSqlTypeBaseName(typeName: string): string {
    const normalized = normalizeSqlTypeName(typeName);
    const parenIndex = normalized.indexOf('(');
    return (parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized).trim();
}

/**
 * Extracts a single numeric parameter from a type specification like `VARCHAR(255)`.
 */
function parseSingleParameter(normalized: string): number | undefined {
    const match = normalized.match(/^[A-Z][A-Z0-9_ ]*\(\s*(\d+)\s*\)\s*(CHAR|BYTE)?$/);
    if (!match) {
        return undefined;
    }
    return Number(match[1]);
}

function parseNumericParameters(normalized: string): { precision?: number; scale?: number } {
    const match = normalized.match(/^[A-Z][A-Z0-9_ ]*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (!match) {
        const single = parseSingleParameter(normalized);
        return single !== undefined ? { precision: single } : {};
    }
    return { precision: Number(match[1]), scale: Number(match[2]) };
}

const NUMERIC_BASES = new Set(['NUMERIC', 'DECIMAL', 'DEC', 'NUMBER']);

/**
 * Parses an arbitrary SQL type string into structured parts.
 */
export function parseSqlType(typeName?: string): ParsedSqlType {
    const normalized = normalizeSqlTypeName(typeName || '');
    if (!normalized) {
        return { base: '', normalized };
    }

    const base = getSqlTypeBaseName(normalized);

    if (NUMERIC_BASES.has(base)) {
        return { base, ...parseNumericParameters(normalized), normalized };
    }

    if (base === 'TIMESTAMP') {
        const scaleMatch = normalized.match(/^TIMESTAMP(?:\(\s*(\d+)\s*\))?(\s+WITH LOCAL TIME ZONE|\s+WITH TIME ZONE)?/);
        const tz = Boolean(scaleMatch?.[2]);
        return {
            base: tz ? 'TIMESTAMP' : 'TIMESTAMP',
            withTimeZone: tz,
            scale: scaleMatch?.[1] ? Number(scaleMatch[1]) : undefined,
            normalized,
        };
    }

    if (base === 'TIME') {
        const tz = normalized.includes('WITH TIME ZONE');
        return {
            base: 'TIME',
            withTimeZone: tz,
            scale: undefined,
            normalized,
        };
    }

    const single = parseSingleParameter(normalized);
    if (single !== undefined) {
        return { base, length: single, normalized };
    }

    return { base, normalized };
}

/**
 * Returns the numeric scale of a `NUMERIC(p,s)` / `DECIMAL(p,s)` type, or undefined.
 */
export function getNumericScaleFromType(typeName?: string): number | undefined {
    const parsed = parseSqlType(typeName);
    return (parsed.base === 'NUMERIC' || parsed.base === 'DECIMAL')
        ? parsed.scale
        : undefined;
}
