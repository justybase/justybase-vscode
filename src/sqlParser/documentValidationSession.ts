import type { ValidationError } from "./types";
import {
  buildStatementIndex,
  diffStatementIndexes,
  type StatementBoundary,
  type StatementIndex,
  type StatementIndexDiff,
} from "./statementIndex";

const MAX_DOCUMENTS = 16;
/**
 * Diagnostic payloads are cached only for statements that produced issues. The
 * coverage map below tracks every validated statement, so clean statements no
 * longer consume this budget and large scripts stay incremental.
 */
const MAX_DIAGNOSTIC_PAYLOAD_ENTRIES_PER_DOCUMENT = 10_000;

export interface DocumentValidationState {
  previousIndex?: StatementIndex;
  nextIndex: StatementIndex;
  diff: StatementIndexDiff;
}

interface CachedTokenPosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  offset: number;
}

/**
 * Diagnostics are cached relative to the owning statement. Statement content is
 * immutable between edits (the cache is keyed by its hash), but its absolute
 * start can move when an earlier edit adds or removes lines/characters.
 */
type CachedValidationError = Omit<ValidationError, "position"> & {
  position: CachedTokenPosition;
};

function toCachedDiagnostic(
  statement: StatementBoundary,
  diagnostic: ValidationError,
): CachedValidationError {
  const position = diagnostic.position;
  return {
    ...diagnostic,
    position: {
      startLine: position.startLine - statement.startLine + 1,
      startColumn:
        position.startLine === statement.startLine
          ? position.startColumn - statement.startColumn + 1
          : position.startColumn,
      endLine: position.endLine - statement.startLine + 1,
      endColumn:
        position.endLine === statement.startLine
          ? position.endColumn - statement.startColumn + 1
          : position.endColumn,
      offset: position.offset - statement.startOffset,
    },
  };
}

function fromCachedDiagnostic(
  statement: StatementBoundary,
  diagnostic: CachedValidationError,
): ValidationError {
  const position = diagnostic.position;
  return {
    ...diagnostic,
    position: {
      startLine: statement.startLine + position.startLine - 1,
      startColumn:
        position.startLine === 1
          ? statement.startColumn + position.startColumn - 1
          : position.startColumn,
      endLine: statement.startLine + position.endLine - 1,
      endColumn:
        position.endLine === 1
          ? statement.startColumn + position.endColumn - 1
          : position.endColumn,
      offset: statement.startOffset + position.offset,
    },
  };
}

interface DocumentDiagnosticsCache {
  statementIndex?: StatementIndex;
  /** Content hash of every validated statement, including clean ones. */
  validatedStatementHashes: Map<number, string>;
  /** Payloads are stored only for statements with at least one diagnostic. */
  diagnosticsByStatement: Map<number, CachedValidationError[]>;
  metadataEpoch?: number;
  createdAtMs: number;
}

export class DocumentValidationSession {
  private readonly documents = new Map<string, DocumentDiagnosticsCache>();

  prepareDocument(documentUri: string, sql: string, databaseKind?: string): DocumentValidationState {
    const cache = this.getOrCreateDocumentCache(documentUri);
    const nextIndex = buildStatementIndex(sql, databaseKind);
    const diff = diffStatementIndexes(cache.statementIndex, nextIndex);

    return {
      previousIndex: cache.statementIndex,
      nextIndex,
      diff,
    };
  }

  commitDocumentIndex(documentUri: string, index: StatementIndex): void {
    const cache = this.getOrCreateDocumentCache(documentUri);
    cache.statementIndex = index;
    cache.createdAtMs = Date.now();
    this.evictDocumentsIfNeeded();
  }

  syncMetadataEpoch(documentUri: string, metadataEpoch: number): void {
    const cache = this.getOrCreateDocumentCache(documentUri);
    if (
      cache.metadataEpoch !== undefined &&
      cache.metadataEpoch !== metadataEpoch
    ) {
      cache.diagnosticsByStatement.clear();
      cache.validatedStatementHashes.clear();
    }
    cache.metadataEpoch = metadataEpoch;
  }

  getCachedDiagnostics(
    documentUri: string,
    statement: StatementBoundary,
    metadataEpoch?: number,
  ): ValidationError[] | undefined {
    const cache = this.documents.get(documentUri);
    if (
      metadataEpoch !== undefined &&
      cache?.metadataEpoch !== undefined &&
      cache.metadataEpoch !== metadataEpoch
    ) {
      return undefined;
    }

    // Coverage is tracked separately from the (capped) diagnostic payloads: a
    // clean statement is reusable even when no payload entry is retained.
    const statementHash = cache?.validatedStatementHashes.get(statement.index);
    if (!cache || statementHash !== statement.contentHash) {
      return undefined;
    }
    const cached = cache.diagnosticsByStatement.get(statement.index);
    return cached
      ? cached.map((diagnostic) => fromCachedDiagnostic(statement, diagnostic))
      : [];
  }

  storeStatementDiagnostics(
    documentUri: string,
    statement: StatementBoundary,
    diagnostics: ValidationError[],
    metadataEpoch?: number,
  ): void {
    const cache = this.getOrCreateDocumentCache(documentUri);
    if (metadataEpoch !== undefined) {
      cache.metadataEpoch = metadataEpoch;
    }
    cache.validatedStatementHashes.set(statement.index, statement.contentHash);
    if (diagnostics.length === 0) {
      // Clean statements keep coverage without a payload.
      cache.diagnosticsByStatement.delete(statement.index);
    } else {
      cache.diagnosticsByStatement.set(
        statement.index,
        diagnostics.map((diagnostic) =>
          toCachedDiagnostic(statement, diagnostic),
        ),
      );
      this.evictStatementDiagnostics(cache);
    }
    cache.createdAtMs = Date.now();
  }

  invalidateDocument(documentUri: string): void {
    this.documents.delete(documentUri);
  }

  clear(): void {
    this.documents.clear();
  }

  private getOrCreateDocumentCache(
    documentUri: string,
  ): DocumentDiagnosticsCache {
    let cache = this.documents.get(documentUri);
    if (!cache) {
      cache = {
        validatedStatementHashes: new Map(),
        diagnosticsByStatement: new Map(),
        createdAtMs: Date.now(),
      };
      this.documents.set(documentUri, cache);
    }
    return cache;
  }

  private evictStatementDiagnostics(cache: DocumentDiagnosticsCache): void {
    while (
      cache.diagnosticsByStatement.size >
      MAX_DIAGNOSTIC_PAYLOAD_ENTRIES_PER_DOCUMENT
    ) {
      const oldest = cache.diagnosticsByStatement.keys().next();
      if (oldest.done) {
        return;
      }
      // Dropping the payload would make the cached result incomplete, so drop
      // coverage for that statement too and let the next pass revalidate it.
      cache.diagnosticsByStatement.delete(oldest.value);
      cache.validatedStatementHashes.delete(oldest.value);
    }
  }

  private evictDocumentsIfNeeded(): void {
    while (this.documents.size > MAX_DOCUMENTS) {
      let oldestKey: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.documents.entries()) {
        if (entry.createdAtMs < oldestTime) {
          oldestTime = entry.createdAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.documents.delete(oldestKey);
    }
  }
}
