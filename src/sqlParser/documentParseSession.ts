import type { DatabaseKind } from "../contracts/database";
import { simpleHash } from "../providers/parsers/hashUtils";
import {
  buildSemanticScopeFromParseResult,
  type ParserSemanticScope,
} from "../providers/parsers/parserSqlContext";
import { isIgnorableTrailingDotParserError } from "./parserErrorUtils";
import {
  parseSqlStatements,
  resolveSqlParsingRuntime,
  type SqlParsingRuntime,
  type SqlStatementsParseResult,
} from "./parsingRuntime";
import type { DatabaseSqlValidationProfile } from "../sql/authoring/types";
import type { CstNode } from "chevrotain";
import {
  resolveSqlRenameSymbol,
  type SqlRenameResolution,
} from "./symbols";

const MAX_PARSE_ENTRIES = 32;
const MAX_SCOPE_ENTRIES = 256;
const MAX_IN_FLIGHT = 16;

export interface DocumentParseRequest {
  documentUri: string;
  documentVersion: number;
  sql: string;
  databaseKind?: DatabaseKind;
  validationProfile?: DatabaseSqlValidationProfile;
  runtime?: SqlParsingRuntime;
}

interface CachedParseEntry {
  parseResult: SqlStatementsParseResult;
  createdAtMs: number;
}

interface CachedScopeEntry {
  scope: ParserSemanticScope;
  createdAtMs: number;
}

export class DocumentParseSession {
  private readonly parseCache = new Map<string, CachedParseEntry>();
  private readonly scopeCache = new Map<string, CachedScopeEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<SqlStatementsParseResult>
  >();
  private readonly documentBindings = new Map<
    string,
    { documentVersion: number; contentHash: string }
  >();
  private parseCacheHits = 0;
  private parseCacheMisses = 0;

  /**
   * Records the latest document version and content hash for the URI.
   * Parse and scope caches key on SHA-1 content hash (`buildParseCacheKey`),
   * not on `documentVersion` alone — identical sql across versions reuses
   * the same parse entry. Scope entries are invalidated implicitly when
   * content changes because the parse cache key changes.
   */
  bindDocumentVersion(
    documentUri: string,
    documentVersion: number,
    sql: string,
  ): void {
    this.documentBindings.set(documentUri, {
      documentVersion,
      contentHash: simpleHash(sql),
    });
  }

  invalidateDocument(documentUri: string): void {
    this.documentBindings.delete(documentUri);
  }

  clear(): void {
    this.parseCache.clear();
    this.scopeCache.clear();
    this.inFlight.clear();
    this.documentBindings.clear();
    this.parseCacheHits = 0;
    this.parseCacheMisses = 0;
  }

  getParseCacheStats(): { hits: number; misses: number } {
    return {
      hits: this.parseCacheHits,
      misses: this.parseCacheMisses,
    };
  }

  getParseResult(request: DocumentParseRequest): SqlStatementsParseResult {
    this.syncDocumentBinding(request);
    const cacheKey = this.buildParseCacheKey(request);
    const cached = this.parseCache.get(cacheKey);
    if (cached) {
      this.parseCacheHits += 1;
      this.touchParseEntry(cacheKey, cached);
      return cached.parseResult;
    }

    return this.parseAndStore(request, cacheKey);
  }

  async getParseResultAsync(
    request: DocumentParseRequest,
  ): Promise<SqlStatementsParseResult> {
    this.syncDocumentBinding(request);
    const cacheKey = this.buildParseCacheKey(request);
    const cached = this.parseCache.get(cacheKey);
    if (cached) {
      this.parseCacheHits += 1;
      this.touchParseEntry(cacheKey, cached);
      return cached.parseResult;
    }

    let inflight = this.inFlight.get(cacheKey);
    if (!inflight) {
      while (this.inFlight.size >= MAX_IN_FLIGHT) {
        await Promise.race(this.inFlight.values());
      }

      inflight = Promise.resolve().then(() => {
        const cachedAfterSchedule = this.parseCache.get(cacheKey);
        if (cachedAfterSchedule) {
          this.parseCacheHits += 1;
          this.touchParseEntry(cacheKey, cachedAfterSchedule);
          return cachedAfterSchedule.parseResult;
        }
        return this.parseAndStore(request, cacheKey);
      });

      this.inFlight.set(cacheKey, inflight);
      void inflight.finally(() => {
        if (this.inFlight.get(cacheKey) === inflight) {
          this.inFlight.delete(cacheKey);
        }
      });
    }

    return inflight;
  }

  getSemanticScope(
    request: DocumentParseRequest & { cursorOffset?: number },
  ): ParserSemanticScope {
    const parseCacheKey = this.buildParseCacheKey(request);
    const scopeCacheKey = this.buildScopeCacheKey(
      parseCacheKey,
      request.cursorOffset,
    );
    const cachedScope = this.scopeCache.get(scopeCacheKey);
    if (cachedScope) {
      this.touchScopeEntry(scopeCacheKey, cachedScope);
      return cachedScope.scope;
    }

    const parseResult = this.getParseResult(request);
    const scope = buildSemanticScopeFromParseResult(
      parseResult,
      request.sql,
      request.cursorOffset,
      request.databaseKind,
    );
    this.storeScopeEntry(scopeCacheKey, scope);
    return scope;
  }

  getStatementCst(
    request: DocumentParseRequest,
    statementIndex: number,
  ): CstNode | undefined {
    const parseResult = this.getParseResult(request);
    return parseResult.cst?.children?.statement?.[statementIndex] as
      | CstNode
      | undefined;
  }

  async getStatementCstAsync(
    request: DocumentParseRequest,
    statementIndex: number,
  ): Promise<CstNode | undefined> {
    const parseResult = await this.getParseResultAsync(request);
    return parseResult.cst?.children?.statement?.[statementIndex] as
      | CstNode
      | undefined;
  }

  private parseAndStore(
    request: DocumentParseRequest,
    cacheKey: string,
  ): SqlStatementsParseResult {
    this.parseCacheMisses += 1;

    const runtime =
      request.runtime ??
      resolveSqlParsingRuntime({
        validationProfile: request.validationProfile,
        databaseKind: request.databaseKind,
      });

    const parseResult = parseSqlStatements({
      sql: request.sql,
      runtime,
      databaseKind: request.databaseKind,
      validationProfile: request.validationProfile,
      ignoreParserError: isIgnorableTrailingDotParserError,
    });

    this.storeParseEntry(cacheKey, parseResult);
    return parseResult;
  }

  private syncDocumentBinding(request: DocumentParseRequest): void {
    this.bindDocumentVersion(
      request.documentUri,
      request.documentVersion,
      request.sql,
    );
  }

  private buildParseCacheKey(request: DocumentParseRequest): string {
    const runtime =
      request.runtime ??
      resolveSqlParsingRuntime({
        validationProfile: request.validationProfile,
        databaseKind: request.databaseKind,
      });
    const contentHash = simpleHash(request.sql);
    return `${runtime.id}|${contentHash}`;
  }

  private buildScopeCacheKey(
    parseCacheKey: string,
    cursorOffset?: number,
  ): string {
    return `${parseCacheKey}|offset:${cursorOffset ?? -1}`;
  }

  private storeParseEntry(
    cacheKey: string,
    parseResult: SqlStatementsParseResult,
  ): void {
    this.evictParseEntriesIfNeeded();
    this.parseCache.set(cacheKey, {
      parseResult,
      createdAtMs: Date.now(),
    });
  }

  private storeScopeEntry(
    cacheKey: string,
    scope: ParserSemanticScope,
  ): void {
    this.evictScopeEntriesIfNeeded();
    this.scopeCache.set(cacheKey, {
      scope,
      createdAtMs: Date.now(),
    });
  }

  private touchParseEntry(cacheKey: string, entry: CachedParseEntry): void {
    entry.createdAtMs = Date.now();
    this.parseCache.delete(cacheKey);
    this.parseCache.set(cacheKey, entry);
  }

  private touchScopeEntry(cacheKey: string, entry: CachedScopeEntry): void {
    entry.createdAtMs = Date.now();
    this.scopeCache.delete(cacheKey);
    this.scopeCache.set(cacheKey, entry);
  }

  private evictParseEntriesIfNeeded(): void {
    while (this.parseCache.size >= MAX_PARSE_ENTRIES) {
      const oldestKey = this.parseCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.parseCache.delete(oldestKey);
    }
  }

  private evictScopeEntriesIfNeeded(): void {
    while (this.scopeCache.size >= MAX_SCOPE_ENTRIES) {
      const oldestKey = this.scopeCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.scopeCache.delete(oldestKey);
    }
  }
}

export function resolveSqlRenameSymbolWithSession(
  session: DocumentParseSession,
  request: DocumentParseRequest,
  offset: number,
): SqlRenameResolution | undefined {
  const parseResult = session.getParseResult(request);
  return resolveSqlRenameSymbol(
    request.sql,
    offset,
    request.databaseKind,
    parseResult,
  );
}
