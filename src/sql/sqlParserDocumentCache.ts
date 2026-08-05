export interface SqlParserDocumentKey {
    documentId: string;
    version: number;
}

export interface StatementAtOffset {
    sql: string;
    start: number;
    end: number;
}

interface CachedStatementAtOffset {
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
    segmentIndex: number;
}

export interface CachedStatementBoundaries {
    textLength: number;
    semicolonOffsets: number[];
    segments: Array<CachedStatementAtOffset | undefined>;
    statements: CachedStatementAtOffset[];
}

const MAX_CACHE_ENTRIES = 50;
const cache = new Map<string, CachedStatementBoundaries>();

function buildCacheKey(documentKey: SqlParserDocumentKey): string {
    return `${documentKey.documentId}:${documentKey.version}`;
}

export function findStatementAtOffset(
    _text: string,
    offset: number,
    boundaries: CachedStatementBoundaries,
): StatementAtOffset | null {
    const segmentIndex = findSegmentIndex(offset, boundaries.semicolonOffsets);
    const statement = boundaries.segments[segmentIndex];
    return statement
        ? {
            sql: _text.substring(statement.contentStart, statement.contentEnd),
            start: statement.start,
            end: statement.end,
        }
        : null;
}

export function findAdjacentStatementAtOffset(
    _text: string,
    offset: number,
    direction: -1 | 1,
    boundaries: CachedStatementBoundaries,
): CachedStatementAtOffset | null {
    const segmentIndex = findSegmentIndex(offset, boundaries.semicolonOffsets);
    const currentStatement = boundaries.segments[segmentIndex];
    const insertionIndex = lowerBoundStatementIndex(boundaries.statements, segmentIndex);
    const targetIndex = currentStatement
        ? insertionIndex + direction
        : direction > 0
            ? insertionIndex
            : insertionIndex - 1;

    return boundaries.statements[targetIndex] ?? null;
}

export function createStatementBoundaries(
    text: string,
    semicolonOffsets: number[],
): CachedStatementBoundaries {
    const segments: Array<CachedStatementAtOffset | undefined> = [];
    const statements: CachedStatementAtOffset[] = [];
    let segmentStart = 0;

    for (let segmentIndex = 0; segmentIndex <= semicolonOffsets.length; segmentIndex += 1) {
        const segmentEnd = semicolonOffsets[segmentIndex] ?? text.length;
        const statement = createStatementAtRange(text, segmentStart, segmentEnd, segmentIndex);
        segments.push(statement);
        if (statement) {
            statements.push(statement);
        }
        segmentStart = segmentEnd + 1;
    }

    return {
        textLength: text.length,
        semicolonOffsets,
        segments,
        statements,
    };
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

    cache.set(buildCacheKey(documentKey), createStatementBoundaries(text, semicolonOffsets));
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

function createStatementAtRange(
    text: string,
    start: number,
    end: number,
    segmentIndex: number,
): CachedStatementAtOffset | undefined {
    let contentStart = start;
    while (contentStart < end && /\s/.test(text[contentStart] ?? '')) {
        contentStart += 1;
    }

    let contentEnd = end;
    while (contentEnd > contentStart && /\s/.test(text[contentEnd - 1] ?? '')) {
        contentEnd -= 1;
    }

    if (contentStart >= contentEnd) {
        return undefined;
    }

    return {
        start,
        end,
        contentStart,
        contentEnd,
        segmentIndex,
    };
}

function findSegmentIndex(offset: number, semicolonOffsets: number[]): number {
    const boundedOffset = Math.max(0, offset);
    let low = 0;
    let high = semicolonOffsets.length;

    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (semicolonOffsets[middle] < boundedOffset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

function lowerBoundStatementIndex(
    statements: CachedStatementAtOffset[],
    segmentIndex: number,
): number {
    let low = 0;
    let high = statements.length;

    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (statements[middle].segmentIndex < segmentIndex) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}
