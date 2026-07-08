export interface SqlParserDocumentKey {
    documentId: string;
    version: number;
}

export interface StatementAtOffset {
    sql: string;
    start: number;
    end: number;
}

interface CachedStatementBoundaries {
    textLength: number;
    semicolonOffsets: number[];
}

const MAX_CACHE_ENTRIES = 50;
const cache = new Map<string, CachedStatementBoundaries>();

function buildCacheKey(documentKey: SqlParserDocumentKey): string {
    return `${documentKey.documentId}:${documentKey.version}`;
}

export function findStatementAtOffset(
    text: string,
    offset: number,
    semicolonOffsets: number[],
): StatementAtOffset | null {
    let start = 0;
    for (const semicolonOffset of semicolonOffsets) {
        if (semicolonOffset < offset) {
            start = semicolonOffset + 1;
        } else {
            break;
        }
    }

    let end = text.length;
    for (const semicolonOffset of semicolonOffsets) {
        if (semicolonOffset >= start) {
            end = semicolonOffset;
            break;
        }
    }

    const sql = text.substring(start, end).trim();
    if (!sql) {
        return null;
    }

    return { sql, start, end };
}

export function getCachedStatementBoundaries(
    documentKey: SqlParserDocumentKey,
    text: string,
): CachedStatementBoundaries | undefined {
    const cached = cache.get(buildCacheKey(documentKey));
    if (!cached || cached.textLength !== text.length) {
        return undefined;
    }

    return cached;
}

export function setCachedStatementBoundaries(
    documentKey: SqlParserDocumentKey,
    text: string,
    semicolonOffsets: number[],
): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
            cache.delete(firstKey);
        }
    }

    cache.set(buildCacheKey(documentKey), {
        textLength: text.length,
        semicolonOffsets,
    });
}

export function clearDocumentStatementCache(documentId?: string): void {
    if (!documentId) {
        cache.clear();
        return;
    }

    for (const key of cache.keys()) {
        if (key.startsWith(`${documentId}:`)) {
            cache.delete(key);
        }
    }
}
