import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { applyGeneratedIdentifierCase } from '../core/dialectTraits';
import { transliterateImportHeader } from '@justybase/database-utils/importColumnNameUtils';

const PRESERVE_CASE_IMPORT_KINDS = new Set<DatabaseKind>(['mysql', 'sqlite']);
const LOWER_CASE_IMPORT_KINDS = new Set<DatabaseKind>(['postgresql', 'duckdb']);

function normalizeImportKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
    if (kind === undefined || kind.trim().length === 0) return undefined;
    const normalizedKind = tryNormalizeDatabaseKind(kind);
    if (!normalizedKind) {
        throw new Error(`Unsupported database kind '${kind}'.`);
    }
    return normalizedKind;
}

function sanitizeHeaderToken(value: string, preserveTrailingLineBreak: boolean): string {
    const hasTrailingLineBreak = /(?:\r\n|\r|\n)+[\t ]*$/.test(value);
    const sanitized = transliterateImportHeader(value)
        .replace(/^[\t ]+|[\t ]+$/g, '')
        .replace(/\r\n|\r|\n/g, '_')
        .replace(/[^0-9A-Za-z_$]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+/g, '');
    return preserveTrailingLineBreak && hasTrailingLineBreak
        ? sanitized
        : sanitized.replace(/_+$/g, '');
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
    let cleaned = sanitizeHeaderToken(
        String(header || ''),
        normalizedKind === 'netezza',
    );

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
    // Empty header cells become positional COLUMN_<n> placeholders, matching
    // the Netezza importer's generated header scheme across every dialect.
    const cleaned = headers.map((header, index) => (
        String(header ?? '').trim().length > 0
            ? normalizeImportedHeader(header, kind)
            : normalizeImportedHeader(`COLUMN_${index + 1}`, kind)
    ));
    const seen = new Map<string, number>();

    return cleaned.map(name => {
        const dedupeKey = name.toUpperCase();
        const count = seen.get(dedupeKey) || 0;
        seen.set(dedupeKey, count + 1);
        return count === 0 ? name : `${name}_${count}`;
    });
}
