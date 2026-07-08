import type { ValidationError } from "./types";
import {
  buildStatementIndex,
  diffStatementIndexes,
  type StatementBoundary,
  type StatementIndex,
  type StatementIndexDiff,
} from "./statementIndex";

const MAX_DOCUMENTS = 16;
const MAX_DIAGNOSTIC_ENTRIES_PER_DOCUMENT = 512;

export interface DocumentValidationState {
  previousIndex?: StatementIndex;
  nextIndex: StatementIndex;
  diff: StatementIndexDiff;
}

interface CachedStatementDiagnostics {
  statementHash: string;
  diagnostics: ValidationError[];
  createdAtMs: number;
}

interface DocumentDiagnosticsCache {
  statementIndex?: StatementIndex;
  diagnosticsByStatement: Map<number, CachedStatementDiagnostics>;
  metadataEpoch?: number;
  createdAtMs: number;
}

export class DocumentValidationSession {
  private readonly documents = new Map<string, DocumentDiagnosticsCache>();

  prepareDocument(documentUri: string, sql: string): DocumentValidationState {
    const cache = this.getOrCreateDocumentCache(documentUri);
    const nextIndex = buildStatementIndex(sql);
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
    const cached = cache?.diagnosticsByStatement.get(statement.index);
    if (!cached || cached.statementHash !== statement.contentHash) {
      return undefined;
    }

    cached.createdAtMs = Date.now();
    return cached.diagnostics;
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
    cache.diagnosticsByStatement.set(statement.index, {
      statementHash: statement.contentHash,
      diagnostics,
      createdAtMs: Date.now(),
    });
    cache.createdAtMs = Date.now();
    this.evictStatementDiagnostics(cache);
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
        diagnosticsByStatement: new Map(),
        createdAtMs: Date.now(),
      };
      this.documents.set(documentUri, cache);
    }
    return cache;
  }

  private evictStatementDiagnostics(cache: DocumentDiagnosticsCache): void {
    while (
      cache.diagnosticsByStatement.size > MAX_DIAGNOSTIC_ENTRIES_PER_DOCUMENT
    ) {
      let oldestKey: number | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, entry] of cache.diagnosticsByStatement.entries()) {
        if (entry.createdAtMs < oldestTime) {
          oldestTime = entry.createdAtMs;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        return;
      }
      cache.diagnosticsByStatement.delete(oldestKey);
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
