import type { DatabaseKind } from '../contracts/database';
import { normalizeDatabaseKind } from '../contracts/database';
import { applyGeneratedIdentifierCase } from '../core/dialectTraits';

const PRESERVE_CASE_IMPORT_KINDS = new Set<DatabaseKind>(['mysql', 'sqlite']);
const LOWER_CASE_IMPORT_KINDS = new Set<DatabaseKind>(['postgresql', 'duckdb']);

function normalizeImportKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
    return kind ? normalizeDatabaseKind(kind) : undefined;
}

function sanitizeHeaderToken(value: string): string {
    return value
        .trim()
        .replace(/[^0-9A-Za-z_$]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function applyImportHeaderCase(value: string, kind?: DatabaseKind): string {
    if (!kind) {
        return applyGeneratedIdentifierCase(value);
    }

    if (PRESERVE_CASE_IMPORT_KINDS.has(kind)) {
        return value;
    }

    if (LOWER_CASE_IMPORT_KINDS.has(kind)) {
        return value.toLowerCase();
    }

    return applyGeneratedIdentifierCase(value, kind);
}

export function normalizeImportedHeader(header: string, kind?: string | DatabaseKind): string {
    const normalizedKind = normalizeImportKind(kind);
    let cleaned = sanitizeHeaderToken(String(header || ''));

    if (!cleaned) {
        return applyImportHeaderCase('COL_EMPTY', normalizedKind);
    }

    if (/^\d/.test(cleaned)) {
        cleaned = `COL_${cleaned}`;
    } else if (cleaned.startsWith('_')) {
        cleaned = `COL${cleaned}`;
    }

    return applyImportHeaderCase(cleaned, normalizedKind);
}

export function normalizeAndDeduplicateHeaders(headers: readonly string[], kind?: string | DatabaseKind): string[] {
    const cleaned = headers.map(header => normalizeImportedHeader(header, kind));
    const seen = new Map<string, number>();

    return cleaned.map(name => {
        const dedupeKey = name.toUpperCase();
        const count = seen.get(dedupeKey) || 0;
        seen.set(dedupeKey, count + 1);
        return count === 0 ? name : `${name}_${count}`;
    });
}
