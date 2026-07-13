import type { CstNode } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import { simpleHash } from "../providers/parsers/hashUtils";
import {
  buildSemanticScopeFromParseResult,
  type ParserSemanticScope,
} from "../providers/parsers/parserSqlContext";
import type { DatabaseSqlValidationProfile } from "../sql/authoring/types";
import { isIgnorableTrailingDotParserError } from "./parserErrorUtils";
import {
  parseSqlStatements,
  resolveSqlParsingRuntime,
  type SqlParsingRuntime,
  type SqlStatementsParseResult,
} from "./parsingRuntime";
import {
  resolveSqlRenameSymbol,
  type SqlRenameResolution,
} from "./symbols";

const MAX_SCOPE_ENTRIES_PER_DOCUMENT = 16;
const MAX_IN_FLIGHT_DOCUMENTS = 16;

export interface DocumentParseRequest {
  documentUri: string;
  documentVersion: number;
  sql: string;
  databaseKind?: DatabaseKind;
  validationProfile?: DatabaseSqlValidationProfile;
  runtime?: SqlParsingRuntime;
}

interface DocumentBinding {
  documentVersion: number;
  contentHash: string;
}

interface CachedParseEntry extends DocumentBinding {
  parseKey: string;
  parseResult: SqlStatementsParseResult;
}

interface InFlightParse {
  parseKey: string;
  promise: Promise<SqlStatementsParseResult>;
}

/**
 * Shares one full parse for the current version of each open document.
 * Older CSTs are discarded as soon as the URI is rebound to new content.
 */
export class DocumentParseSession {
  private readonly parseCache = new Map<string, CachedParseEntry>();
  private readonly scopeCache = new Map<string, Map<string, ParserSemanticScope>>();
  private readonly inFlight = new Map<string, InFlightParse>();
  private readonly documentBindings = new Map<string, DocumentBinding>();
  private parseCacheHits = 0;
  private parseCacheMisses = 0;

  bindDocumentVersion(
    documentUri: string,
    documentVersion: number,
    sql: string,
  ): void {
    const next = { documentVersion, contentHash: simpleHash(sql) };
    const current = this.documentBindings.get(documentUri);
    if (current && documentVersion < current.documentVersion) {
      return;
    }
    if (
      current?.documentVersion === next.documentVersion &&
      current?.contentHash === next.contentHash
    ) {
      return;
    }
    if (current?.contentHash === next.contentHash) {
      this.documentBindings.set(documentUri, next);
      return;
    }

    this.documentBindings.set(documentUri, next);
    this.parseCache.delete(documentUri);
    this.scopeCache.delete(documentUri);
  }

  invalidateDocument(documentUri: string): void {
    this.documentBindings.delete(documentUri);
    this.parseCache.delete(documentUri);
    this.scopeCache.delete(documentUri);
    this.inFlight.delete(documentUri);
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
    return { hits: this.parseCacheHits, misses: this.parseCacheMisses };
  }

  /** Exposed for cache-bound regression tests and diagnostics. */
  getCacheSizes(): { parses: number; scopes: number; documents: number } {
    let scopes = 0;
    for (const entries of this.scopeCache.values()) {
      scopes += entries.size;
    }
    return {
      parses: this.parseCache.size,
      scopes,
      documents: this.documentBindings.size,
    };
  }

  getParseResult(request: DocumentParseRequest): SqlStatementsParseResult {
    this.syncDocumentBinding(request);
    const parseKey = this.buildParseKey(request);
    const cached = this.parseCache.get(request.documentUri);
    if (cached?.parseKey === parseKey) {
      this.parseCacheHits += 1;
      return cached.parseResult;
    }
    return this.parseAndStore(request, parseKey);
  }

  async getParseResultAsync(
    request: DocumentParseRequest,
  ): Promise<SqlStatementsParseResult> {
    this.syncDocumentBinding(request);
    const parseKey = this.buildParseKey(request);
    const cached = this.parseCache.get(request.documentUri);
    if (cached?.parseKey === parseKey) {
      this.parseCacheHits += 1;
      return cached.parseResult;
    }

    const existing = this.inFlight.get(request.documentUri);
    if (existing?.parseKey === parseKey) {
      return existing.promise;
    }

    if (!this.isCurrentBinding(request)) {
      return this.parseAndStore(request, parseKey);
    }

    while (this.inFlight.size >= MAX_IN_FLIGHT_DOCUMENTS) {
      await Promise.race(
        Array.from(this.inFlight.values(), (entry) => entry.promise),
      );
    }

    const promise = Promise.resolve().then(() => {
      const cachedAfterSchedule = this.parseCache.get(request.documentUri);
      if (cachedAfterSchedule?.parseKey === parseKey) {
        this.parseCacheHits += 1;
        return cachedAfterSchedule.parseResult;
      }
      return this.parseAndStore(request, parseKey);
    });
    this.inFlight.set(request.documentUri, { parseKey, promise });
    void promise.finally(() => {
      if (this.inFlight.get(request.documentUri)?.promise === promise) {
        this.inFlight.delete(request.documentUri);
      }
    });
    return promise;
  }

  getSemanticScope(
    request: DocumentParseRequest & { cursorOffset?: number },
  ): ParserSemanticScope {
    this.syncDocumentBinding(request);
    const parseKey = this.buildParseKey(request);
    const scopeKey = `${parseKey}|offset:${request.cursorOffset ?? -1}`;
    const entries = this.scopeCache.get(request.documentUri);
    const cached = entries?.get(scopeKey);
    if (cached) {
      entries!.delete(scopeKey);
      entries!.set(scopeKey, cached);
      return cached;
    }

    const parseResult = this.getParseResult(request);
    const scope = buildSemanticScopeFromParseResult(
      parseResult,
      request.sql,
      request.cursorOffset,
      request.databaseKind,
    );
    if (this.isCurrentBinding(request)) {
      this.storeScope(request.documentUri, scopeKey, scope);
    }
    return scope;
  }

  getStatementCst(
    request: DocumentParseRequest,
    statementIndex: number,
  ): CstNode | undefined {
    return this.getParseResult(request).cst?.children?.statement?.[
      statementIndex
    ] as CstNode | undefined;
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
    parseKey: string,
  ): SqlStatementsParseResult {
    this.parseCacheMisses += 1;
    const runtime = this.resolveRuntime(request);
    const parseResult = parseSqlStatements({
      sql: request.sql,
      runtime,
      databaseKind: request.databaseKind,
      validationProfile: request.validationProfile,
      ignoreParserError: isIgnorableTrailingDotParserError,
    });

    // A queued parse may finish after a newer version has rebound this URI.
    if (this.isCurrentBinding(request)) {
      this.parseCache.set(request.documentUri, {
        documentVersion: request.documentVersion,
        contentHash: simpleHash(request.sql),
        parseKey,
        parseResult,
      });
    }
    return parseResult;
  }

  private syncDocumentBinding(request: DocumentParseRequest): void {
    this.bindDocumentVersion(
      request.documentUri,
      request.documentVersion,
      request.sql,
    );
  }

  private isCurrentBinding(request: DocumentParseRequest): boolean {
    const binding = this.documentBindings.get(request.documentUri);
    return (
      binding?.documentVersion === request.documentVersion &&
      binding.contentHash === simpleHash(request.sql)
    );
  }

  private resolveRuntime(request: DocumentParseRequest): SqlParsingRuntime {
    return (
      request.runtime ??
      resolveSqlParsingRuntime({
        validationProfile: request.validationProfile,
        databaseKind: request.databaseKind,
      })
    );
  }

  private buildParseKey(request: DocumentParseRequest): string {
    return `${this.resolveRuntime(request).id}|${simpleHash(request.sql)}`;
  }

  private storeScope(
    documentUri: string,
    scopeKey: string,
    scope: ParserSemanticScope,
  ): void {
    let entries = this.scopeCache.get(documentUri);
    if (!entries) {
      entries = new Map();
      this.scopeCache.set(documentUri, entries);
    }
    while (entries.size >= MAX_SCOPE_ENTRIES_PER_DOCUMENT) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    entries.set(scopeKey, scope);
  }
}

export function resolveSqlRenameSymbolWithSession(
  session: DocumentParseSession,
  request: DocumentParseRequest,
  offset: number,
): SqlRenameResolution | undefined {
  return resolveSqlRenameSymbol(
    request.sql,
    offset,
    request.databaseKind,
    session.getParseResult(request),
  );
}
