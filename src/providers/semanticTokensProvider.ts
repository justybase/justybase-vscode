import * as vscode from "vscode";
import { SqlLexer } from "../dialects/netezza/sql/lexer";
import {
  NETEZZA_BUILTIN_FUNCTIONS,
  NETEZZA_SPECIAL_BUILTIN_VALUES,
  NETEZZA_SYSTEM_COLUMNS,
} from "../dialects/netezza/sql/builtins";
import { getNetezzaTypeSpec } from "../dialects/netezza/sql/dataTypes";
import { parseSemanticScopeWithParser, type ParserSemanticScope } from "./parsers/parserSqlContext";
import {
  collectIdentifierOccurrencesFromScope,
  type IdentifierSemanticRole,
} from "./parsers/identifierRoleCollector";
import type { DatabaseKind } from "../contracts/database";
import { getCachedColumnsFromMetadataCache } from "../metadata/columnCacheLookup";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { isOffsetInSqlComment } from "../sql/sqlSourceScan";
import { LARGE_SCRIPT_CHAR_THRESHOLD } from "../sqlParser/validationConfig";
import { simpleHash } from "./parsers/hashUtils";
import { tryGetLogger } from "../utils/logger";

const SEMANTIC_TOKEN_DEBOUNCE_MS = 150;
const SLOW_SEMANTIC_TOKEN_MS = 100;

interface SemanticTokenCacheEntry {
  identity: string;
  tokens: vscode.SemanticTokens;
}

interface PendingSemanticRequest {
  identity: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<vscode.SemanticTokens>;
  resolve: (tokens: vscode.SemanticTokens) => void;
}

const LEGEND = new vscode.SemanticTokensLegend(
  [
    "enumMember",
    "function",
    "keyword",
    "macro",
    "modifier",
    "variable",
    "type",
    "column",
    "table",
    "alias",
    "schema",
    "database",
    "localVariable",
  ],
  ["readonly", "defaultLibrary", "italic"],
);

const enum TypeIdx {
  enumMember,
  function,
  keyword,
  macro,
  modifier,
  variable,
  type,
  column,
  table,
  alias,
  schema,
  database,
  localVariable,
}

const enum ModifierMask {
  readonly = 1 << 0,
  defaultLibrary = 1 << 1,
  italic = 1 << 2,
}

const KEYWORD_TOKEN_NAMES = new Set([
  "Groom",
  "Versions",
  "Records",
  "Pages",
  "Ready",
  "Reclaim",
  "Backupset",
  "Organize",
  "Distribute",
  "Random",
  "SameAs",
  "Express",
  "None",
  "Show",
  "Copy",
  "Lock",
  "Reindex",
  "Reset",
  "Merge",
  "External",
  "Comment",
  "Synonym",
  "Cascade",
  "Restrict",
  "Groups",
  "Filter",
  "Exclude",
  "Ties",
  "Plantext",
  "Plangraph",
  "Verbose",
  "Distribution",
  "Ilike",
  "Views",
  "Explain",
  "Nzplsql",
  "Returns",
  "Language",
  "Owner",
  "Caller",
  "RefTable",
  "Varargs",
  "Alias",
  "Constant",
  "Execute",
  "Exec",
  "Call",
  "Immediate",
  "Hash",
  "Deferrable",
  "Initially",
  "Generate",
  "Next",
  "Statistics",
  "Start",
]);

const MACRO_TOKEN_NAMES = new Set([
  "BeginProc",
  "EndProc",
  "Exception",
  "Raise",
  "Notice",
  "Debug",
  "Declare",
  "Elsif",
  "Loop",
  "While",
  "Exit",
]);

const MODIFIER_TOKEN_NAMES = new Set(["Temp", "Temporary", "Global"]);

function isNetezzaType(text: string): boolean {
  return getNetezzaTypeSpec(text) !== undefined;
}

function roleToTypeIdx(role: IdentifierSemanticRole): TypeIdx | undefined {
  switch (role) {
    case "column":
      return TypeIdx.column;
    case "table":
    case "cte":
      return TypeIdx.table;
    case "alias":
      return TypeIdx.alias;
    case "schema":
      return TypeIdx.schema;
    case "database":
      return TypeIdx.database;
    case "localVariable":
      return TypeIdx.localVariable;
    default:
      return undefined;
  }
}

export class NetezzaSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider
{
  private readonly _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;
  private readonly tokenCache = new Map<string, SemanticTokenCacheEntry>();
  private readonly pendingRequests = new Map<string, PendingSemanticRequest>();
  private readonly connectionEpochs = new Map<string, number>();
  private globalMetadataEpoch = 0;

  constructor(
    private readonly metadataCache?: MetadataCache,
    private readonly connectionManager?: ConnectionManager,
    private readonly parseSession?: DocumentParseSession,
    private readonly debounceMs = process.env.NODE_ENV === "test"
      ? 0
      : SEMANTIC_TOKEN_DEBOUNCE_MS,
  ) {}

  getLegend(): vscode.SemanticTokensLegend {
    return LEGEND;
  }

  refresh(connectionName?: string): void {
    if (connectionName) {
      const key = connectionName.toUpperCase();
      this.connectionEpochs.set(key, (this.connectionEpochs.get(key) ?? 0) + 1);
    } else {
      this.globalMetadataEpoch += 1;
      this.tokenCache.clear();
    }
    this._onDidChangeSemanticTokens.fire();
  }

  invalidateDocument(documentUri: string): void {
    this.cancelPending(documentUri, "document-context-changed");
    this.tokenCache.delete(documentUri);
    this._onDidChangeSemanticTokens.fire();
  }

  releaseDocument(documentUri: string): void {
    this.cancelPending(documentUri, "document-closed");
    this.tokenCache.delete(documentUri);
  }

  dispose(): void {
    for (const documentUri of this.pendingRequests.keys()) {
      this.cancelPending(documentUri, "provider-disposed");
    }
    this.tokenCache.clear();
    this._onDidChangeSemanticTokens.dispose();
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.SemanticTokens | Promise<vscode.SemanticTokens> {
    const text = document.getText();
    const documentUri = document.uri.toString();
    const connectionName = this.connectionManager?.getConnectionForExecution(
      documentUri,
    );
    const identity = this.buildTokenIdentity(
      document.version,
      text,
      connectionName,
    );

    if (token.isCancellationRequested) {
      return this.emptyTokens();
    }

    const cached = this.tokenCache.get(documentUri);
    if (cached?.identity === identity) {
      return cached.tokens;
    }

    if (this.debounceMs <= 0) {
      return this.computeTokens(
        document,
        text,
        token,
        identity,
        connectionName,
        false,
      );
    }

    const pending = this.pendingRequests.get(documentUri);
    if (pending) {
      this.cancelPending(documentUri, "superseded");
    }

    let resolveRequest!: (tokens: vscode.SemanticTokens) => void;
    const promise = new Promise<vscode.SemanticTokens>((resolve) => {
      resolveRequest = resolve;
    });
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      const current = this.pendingRequests.get(documentUri);
      if (current?.identity !== identity || token.isCancellationRequested) {
        this.cancelPending(documentUri, "cancelled-before-tokenize");
        return;
      }
      this.pendingRequests.delete(documentUri);
      resolveRequest(
        this.computeTokens(
          document,
          text,
          token,
          identity,
          connectionName,
          false,
        ),
      );
    }, this.debounceMs);
    this.pendingRequests.set(documentUri, {
      identity,
      startedAt,
      timer,
      promise,
      resolve: resolveRequest,
    });
    return promise;
  }

  private computeTokens(
    document: vscode.TextDocument,
    text: string,
    token: vscode.CancellationToken,
    identity: string,
    connectionName: string | undefined,
    cacheHit: boolean,
    startedAt = performance.now(),
  ): vscode.SemanticTokens {
    const documentUri = document.uri.toString();

    try {
      const tokens = this.tokenize(text, document, token);
      const cancelled = token.isCancellationRequested;
      if (!cancelled && this.buildTokenIdentity(document.version, text, connectionName) === identity) {
        this.tokenCache.set(documentUri, { identity, tokens });
      }
      this.logSlowPath(document, text.length, startedAt, cacheHit, cancelled);
      return cancelled ? this.emptyTokens() : tokens;
    } catch (error: unknown) {
      this.logSlowPath(document, text.length, startedAt, cacheHit, true, error);
      return this.emptyTokens();
    }
  }

  private buildTokenIdentity(
    documentVersion: number,
    text: string,
    connectionName?: string,
  ): string {
    const connectionKey = connectionName?.toUpperCase() ?? "";
    const connectionEpoch = this.connectionEpochs.get(connectionKey) ?? 0;
    return `${documentVersion}|${simpleHash(text)}|${this.globalMetadataEpoch}|${connectionKey}|${connectionEpoch}`;
  }

  private cancelPending(documentUri: string, reason: string): void {
    const pending = this.pendingRequests.get(documentUri);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(documentUri);
    pending.resolve(this.emptyTokens());
    const durationMs = performance.now() - pending.startedAt;
    if (durationMs >= SLOW_SEMANTIC_TOKEN_MS) {
      tryGetLogger()?.warn(
        `[SemanticTokens] slow cancelled request uri=${documentUri} durationMs=${durationMs.toFixed(1)} reason=${reason}`,
      );
    }
  }

  private emptyTokens(): vscode.SemanticTokens {
    return new vscode.SemanticTokens(new Uint32Array(0));
  }

  private logSlowPath(
    document: vscode.TextDocument,
    length: number,
    startedAt: number,
    cacheHit: boolean,
    cancelled: boolean,
    error?: unknown,
  ): void {
    const durationMs = performance.now() - startedAt;
    if (durationMs < SLOW_SEMANTIC_TOKEN_MS) return;
    const memory = process.memoryUsage();
    const suffix = error
      ? ` error=${error instanceof Error ? error.message : String(error)}`
      : "";
    tryGetLogger()?.warn(
      `[SemanticTokens] slow uri=${document.uri.toString()} version=${document.version} length=${length} durationMs=${durationMs.toFixed(1)} cache=${cacheHit ? "hit" : "miss"} cancelled=${cancelled} heapUsed=${memory.heapUsed} rss=${memory.rss}${suffix}`,
    );
  }

  private resolveEffectiveDatabase(
    docUri: string,
    connectionName: string,
  ): string | undefined {
    const override = this.connectionManager!.getDocumentDatabase(docUri);
    if (override) return override;

    const connMeta = this.connectionManager!.getConnectionMetadata(connectionName);
    return connMeta?.database;
  }

  private collectColumnNames(
    aliasBindings: Map<
      string,
      { db?: string; schema?: string; table: string }
    >,
    connectionName: string,
    metadataCache: MetadataCache,
    effectiveDatabase?: string,
    databaseKind?: DatabaseKind,
  ): Set<string> {
    const columnNames = new Set<string>();
    const seenTables = new Set<string>();

    for (const [, binding] of aliasBindings) {
      const tableKey = `${binding.db ?? ""}|${binding.schema ?? ""}|${binding.table}`;
      if (seenTables.has(tableKey.toUpperCase())) continue;
      seenTables.add(tableKey.toUpperCase());

      try {
        let columns: { ATTNAME: string }[] | undefined;

        if (binding.db && binding.schema) {
          columns = getCachedColumnsFromMetadataCache(
            metadataCache,
            connectionName,
            binding.db,
            binding.schema,
            binding.table,
            databaseKind,
          );
        } else if (binding.db && !binding.schema) {
          columns = metadataCache.getColumnsAnySchema(
            connectionName,
            binding.db,
            binding.table,
          );
        } else if (effectiveDatabase) {
          columns = metadataCache.getColumnsAnySchema(
            connectionName,
            effectiveDatabase,
            binding.table,
          );
        }

        if (columns) {
          for (const col of columns) {
            if (col.ATTNAME) {
              columnNames.add(col.ATTNAME.toUpperCase());
            }
          }
        }
      } catch {
        // Metadata lookup failed — skip this table
      }
    }

    return columnNames;
  }

  private tokenize(
    text: string,
    document: vscode.TextDocument,
    cancellationToken: vscode.CancellationToken,
  ): vscode.SemanticTokens {
    if (cancellationToken.isCancellationRequested) return this.emptyTokens();
    const lexResult = SqlLexer.tokenize(text);
    const builder = new vscode.SemanticTokensBuilder(LEGEND);

    const documentUri = document.uri.toString();
    const databaseKind = this.connectionManager?.getExecutionDatabaseKind(
      documentUri,
    );

    if (cancellationToken.isCancellationRequested) return this.emptyTokens();
    const useParser = text.length <= LARGE_SCRIPT_CHAR_THRESHOLD;
    const scope = useParser
      ? this.resolveDocumentScope(document, text, databaseKind)
      : undefined;
    const identifierRoles = scope
      ? collectIdentifierOccurrencesFromScope(scope)
      : new Map<number, { role: IdentifierSemanticRole }>();
    const aliasNames = new Set<string>();
    let columnNames = new Set<string>();

    if (scope) {
      try {
        const bindingsForColoring =
          scope.globalAliasBindings.size > 0
            ? scope.globalAliasBindings
            : scope.preferredAliasBindings;

        bindingsForColoring.forEach((binding, key) => {
          if (key !== binding.table.toUpperCase()) {
            aliasNames.add(key);
          }
        });

        if (
          this.metadataCache &&
          this.connectionManager &&
          bindingsForColoring.size > 0
        ) {
          const connectionName =
            this.connectionManager.getConnectionForExecution(documentUri);
          if (connectionName) {
            const effectiveDatabase = this.resolveEffectiveDatabase(
              documentUri,
              connectionName,
            );
            columnNames = this.collectColumnNames(
              bindingsForColoring,
              connectionName,
              this.metadataCache,
              effectiveDatabase,
              databaseKind,
            );
          }
        }
      } catch {
        // Metadata lookup failed — proceed with CST map and lexer fallback only
      }
    }

    let previousTokenWasAlias = false;

    for (let tokenIndex = 0; tokenIndex < lexResult.tokens.length; tokenIndex++) {
      if (
        tokenIndex % 256 === 0 &&
        cancellationToken.isCancellationRequested
      ) {
        return this.emptyTokens();
      }
      const token = lexResult.tokens[tokenIndex];
      const tokenTypeName = token.tokenType.name;
      const startOffset = token.startOffset;
      const image = token.image;
      if (!image) {
        continue;
      }

      if (isOffsetInSqlComment(text, startOffset)) {
        continue;
      }

      const length = image.length;
      if (length <= 0) {
        continue;
      }

      let typeIdx: TypeIdx | undefined;
      let modifierMask = 0;

      if (KEYWORD_TOKEN_NAMES.has(tokenTypeName)) {
        typeIdx = TypeIdx.keyword;
      } else if (MACRO_TOKEN_NAMES.has(tokenTypeName)) {
        typeIdx = TypeIdx.macro;
      } else if (MODIFIER_TOKEN_NAMES.has(tokenTypeName)) {
        typeIdx = TypeIdx.modifier;
      } else if (tokenTypeName === "Identifier") {
        const word = image.toUpperCase();
        const roleOccurrence = identifierRoles.get(startOffset);

        if (NETEZZA_BUILTIN_FUNCTIONS.has(word)) {
          typeIdx = TypeIdx.function;
        } else if (NETEZZA_SPECIAL_BUILTIN_VALUES.has(word)) {
          typeIdx = TypeIdx.enumMember;
        } else if (NETEZZA_SYSTEM_COLUMNS.has(word)) {
          typeIdx = TypeIdx.variable;
          modifierMask = ModifierMask.readonly;
        } else if (isNetezzaType(word)) {
          typeIdx = TypeIdx.type;
        } else if (roleOccurrence) {
          typeIdx = roleToTypeIdx(roleOccurrence.role);
          if (roleOccurrence.role === "alias") {
            modifierMask = ModifierMask.italic;
          }
        } else if (columnNames.has(word)) {
          typeIdx = TypeIdx.column;
        } else if (previousTokenWasAlias) {
          typeIdx = TypeIdx.column;
        }

        previousTokenWasAlias = aliasNames.has(word);
      } else if (tokenTypeName !== "Dot") {
        previousTokenWasAlias = false;
      }

      if (typeIdx === undefined) {
        continue;
      }

      const pos = document.positionAt(startOffset);
      builder.push(pos.line, pos.character, length, typeIdx, modifierMask);
    }

    return builder.build();
  }

  private resolveDocumentScope(
    document: vscode.TextDocument,
    text: string,
    databaseKind?: ReturnType<
      ConnectionManager["getExecutionDatabaseKind"]
    >,
  ): ParserSemanticScope {
    const documentUri = document.uri.toString();

    if (this.parseSession) {
      try {
        return this.parseSession.getSemanticScope({
          documentUri,
          documentVersion: document.version,
          sql: text,
          databaseKind,
        });
      } catch {
        // Fall back to direct parse when session path fails.
      }
    }

    return parseSemanticScopeWithParser(text, undefined, databaseKind);
  }
}
