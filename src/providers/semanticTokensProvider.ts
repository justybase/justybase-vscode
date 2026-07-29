import * as vscode from "vscode";
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
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import { getCachedColumnsFromMetadataCache } from "../metadata/columnCacheLookup";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { resolveSqlParsingRuntime } from "../sqlParser/parsingRuntime";
import { buildSqlSourceScanIndex } from "../sql/sqlSourceScan";
import {
  isLargeScriptDocument,
  LARGE_SCRIPT_CHAR_THRESHOLD,
} from "../sqlParser/validationConfig";
import { simpleHash } from "./parsers/hashUtils";
import { tryGetLogger } from "../utils/logger";
import { getUxPerfSession } from "../services/perf/uxPerfSession";

const SEMANTIC_TOKEN_DEBOUNCE_MS = 150;
/** Longer coalesce window while typing in multi-thousand-line CTE scripts. */
const SEMANTIC_TOKEN_LARGE_LINE_DEBOUNCE_MS = 800;
const SLOW_SEMANTIC_TOKEN_MS = 100;

interface SemanticTokenCacheEntry {
  identity: string;
  tokens: vscode.SemanticTokens;
}

/** Name-based roles from the last full parse — reused by progressive lex-only. */
interface SemanticRoleNameCache {
  aliasNames: Set<string>;
  cteNames: Set<string>;
  columnNames: Set<string>;
}

interface PendingSemanticUpgrade {
  identity: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
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
  // Db2 LUW phrase tokens
  "Db2OptimizeFor",
  "Db2WithUr",
  "Db2WithCs",
  "Db2WithRs",
  "Db2WithRr",
  "Db2ForReadOnly",
  "Db2ForUpdate",
  "Db2FinalTable",
  "Db2OldTable",
  "Db2NewTable",
  "Db2ModifiedBy",
  "Db2DeclareGlobalTemporary",
  "Db2GeneratedAlways",
  "Db2GeneratedByDefault",
  "Db2Identity",
  "Db2OrganizeBy",
  "Db2DataCapture",
  "Db2CurrentSchema",
  "Db2CurrentServer",
  "Db2CurrentDate",
  "Db2CurrentTime",
  "Db2CurrentTimestamp",
  "Db2CurrentUser",
  "Db2LanguageSql",
  "Db2Nickname",
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

function resolveSemanticAuthoring(databaseKind?: DatabaseKind) {
  try {
    return getDatabaseSqlAuthoring(databaseKind);
  } catch {
    return getDatabaseSqlAuthoring("netezza");
  }
}

function isAuthoringType(
  text: string,
  databaseKind?: DatabaseKind,
): boolean {
  const authoring = resolveSemanticAuthoring(databaseKind);
  if (authoring.validation.getTypeSpec(text)) {
    return true;
  }
  if (!databaseKind || databaseKind === "netezza") {
    return isNetezzaType(text);
  }
  return false;
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
  private readonly roleNameCache = new Map<string, SemanticRoleNameCache>();
  private readonly pendingUpgrades = new Map<string, PendingSemanticUpgrade>();
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

  private resolveDebounceMs(document: vscode.TextDocument, textLength: number): number {
    if (this.debounceMs <= 0) {
      return 0;
    }
    if (isLargeScriptDocument(document.lineCount, textLength)) {
      return Math.max(this.debounceMs, SEMANTIC_TOKEN_LARGE_LINE_DEBOUNCE_MS);
    }
    return this.debounceMs;
  }

  private getStaleTokens(documentUri: string): vscode.SemanticTokens {
    return this.tokenCache.get(documentUri)?.tokens ?? this.emptyTokens();
  }

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
      this.roleNameCache.clear();
    }
    this._onDidChangeSemanticTokens.fire();
  }

  invalidateDocument(documentUri: string): void {
    this.cancelPendingUpgrade(documentUri, "document-context-changed");
    this.tokenCache.delete(documentUri);
    this.roleNameCache.delete(documentUri);
    this._onDidChangeSemanticTokens.fire();
  }

  releaseDocument(documentUri: string): void {
    this.cancelPendingUpgrade(documentUri, "document-closed");
    this.tokenCache.delete(documentUri);
    this.roleNameCache.delete(documentUri);
  }

  dispose(): void {
    for (const documentUri of this.pendingUpgrades.keys()) {
      this.cancelPendingUpgrade(documentUri, "provider-disposed");
    }
    this.tokenCache.clear();
    this.roleNameCache.clear();
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
      return this.getStaleTokens(documentUri);
    }

    const cached = this.tokenCache.get(documentUri);
    if (cached?.identity === identity) {
      this.emitUxSemanticTokens(
        document,
        text.length,
        0,
        0,
        true,
        false,
        text.length > LARGE_SCRIPT_CHAR_THRESHOLD,
        "full",
      );
      return cached.tokens;
    }

    const debounceMs = this.resolveDebounceMs(document, text.length);
    const canParse = text.length <= LARGE_SCRIPT_CHAR_THRESHOLD;

    // Tests / zero-debounce, or scripts too large for CST: final tokens immediately.
    if (debounceMs <= 0 || !canParse) {
      return this.computeTokens(
        document,
        text,
        token,
        identity,
        connectionName,
        false,
        {
          useParser: canParse,
          quality: canParse ? "full" : "lex",
          cacheResult: true,
        },
      );
    }

    // Progressive path: sync lex-only (correct line positions after Enter),
    // then upgrade to full CST roles after debounce.
    this.cancelPendingUpgrade(documentUri, "superseded");

    const lexTokens = this.computeTokens(
      document,
      text,
      token,
      identity,
      connectionName,
      false,
      { useParser: false, quality: "lex", cacheResult: false },
    );

    if (token.isCancellationRequested) {
      return lexTokens;
    }

    const startedAt = performance.now();
    const timer = setTimeout(() => {
      const current = this.pendingUpgrades.get(documentUri);
      if (!current || current.identity !== identity) {
        return;
      }
      this.pendingUpgrades.delete(documentUri);
      if (token.isCancellationRequested) {
        return;
      }
      this.computeTokens(
        document,
        text,
        token,
        identity,
        connectionName,
        false,
        {
          useParser: true,
          quality: "full",
          cacheResult: true,
        },
        performance.now(),
        current.startedAt,
      );
      // Ask VS Code to re-query so it picks up cached full tokens.
      this._onDidChangeSemanticTokens.fire();
    }, debounceMs);

    this.pendingUpgrades.set(documentUri, {
      identity,
      startedAt,
      timer,
    });

    return lexTokens;
  }

  private computeTokens(
    document: vscode.TextDocument,
    text: string,
    token: vscode.CancellationToken,
    identity: string,
    connectionName: string | undefined,
    cacheHit: boolean,
    options: {
      useParser: boolean;
      quality: "lex" | "full";
      cacheResult: boolean;
    },
    startedAt = performance.now(),
    wallStartedAt = startedAt,
  ): vscode.SemanticTokens {
    const documentUri = document.uri.toString();
    const parseSkippedLarge =
      text.length > LARGE_SCRIPT_CHAR_THRESHOLD || !options.useParser;

    try {
      const computeStartedAt = performance.now();
      const tokens = this.tokenize(text, document, token, {
        useParser: options.useParser,
      });
      const computeMs = performance.now() - computeStartedAt;
      const cancelled = token.isCancellationRequested;
      if (
        !cancelled &&
        options.cacheResult &&
        this.buildTokenIdentity(document.version, text, connectionName) === identity
      ) {
        this.tokenCache.set(documentUri, { identity, tokens });
      }
      this.logSlowPath(document, text.length, startedAt, cacheHit, cancelled);
      this.emitUxSemanticTokens(
        document,
        text.length,
        computeMs,
        performance.now() - wallStartedAt,
        cacheHit,
        cancelled,
        parseSkippedLarge,
        options.quality,
      );
      return cancelled ? this.getStaleTokens(documentUri) : tokens;
    } catch (error: unknown) {
      this.logSlowPath(document, text.length, startedAt, cacheHit, true, error);
      this.emitUxSemanticTokens(
        document,
        text.length,
        performance.now() - startedAt,
        performance.now() - wallStartedAt,
        cacheHit,
        true,
        parseSkippedLarge,
        options.quality,
      );
      return this.getStaleTokens(documentUri);
    }
  }

  private emitUxSemanticTokens(
    document: vscode.TextDocument,
    length: number,
    computeMs: number,
    wallMs: number,
    cacheHit: boolean,
    cancelled: boolean,
    parseSkippedLarge: boolean,
    quality: "lex" | "full",
  ): void {
    const ux = getUxPerfSession();
    if (!ux.isActive()) {
      return;
    }
    const documentUri = document.uri.toString();
    // Only attribute change→tokens when a recent keystroke exists (skips idle /
    // tab-switch / cache-refresh noise that previously produced multi-minute "slow").
    const changeToTokensMs = ux.getRecentDocChangeMs(documentUri);
    ux.emit({
      op: "editor.semantic_tokens",
      phase: "end",
      durationMs: computeMs,
      doc: ux.docContextFromDocument(document),
      meta: {
        debounceMs: this.resolveDebounceMs(document, length),
        computeMs: Math.round(computeMs * 10) / 10,
        wallMs: Math.round(wallMs * 10) / 10,
        cacheHit,
        cancelled,
        parseSkippedLarge,
        quality,
        length,
        version: document.version,
      },
    });
    if (changeToTokensMs !== undefined && !cancelled && !cacheHit) {
      ux.emit({
        op: "editor.change_to_tokens",
        phase: "end",
        durationMs: changeToTokensMs,
        doc: ux.docContextFromDocument(document),
        meta: {
          computeMs: Math.round(computeMs * 10) / 10,
          wallMs: Math.round(wallMs * 10) / 10,
          cacheHit,
          quality,
        },
      });
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

  private cancelPendingUpgrade(documentUri: string, reason: string): void {
    const pending = this.pendingUpgrades.get(documentUri);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUpgrades.delete(documentUri);
    const durationMs = performance.now() - pending.startedAt;
    if (durationMs >= SLOW_SEMANTIC_TOKEN_MS) {
      tryGetLogger()?.warn(
        `[SemanticTokens] slow cancelled upgrade uri=${documentUri} durationMs=${durationMs.toFixed(1)} reason=${reason}`,
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
    options?: { useParser?: boolean },
  ): vscode.SemanticTokens {
    const documentUri = document.uri.toString();
    if (cancellationToken.isCancellationRequested) {
      return this.getStaleTokens(documentUri);
    }

    const databaseKind = this.connectionManager?.getExecutionDatabaseKind(
      documentUri,
    );
    const runtime = resolveSqlParsingRuntime({ databaseKind });
    const lexResult = runtime.SqlLexer.tokenize(text);
    const builder = new vscode.SemanticTokensBuilder(LEGEND);
    const authoring = resolveSemanticAuthoring(databaseKind);
    const builtinFunctions = authoring.validation.builtinFunctions;
    const specialBuiltinValues = authoring.validation.specialBuiltinValues;
    const systemColumns = authoring.validation.systemColumns.size > 0
      ? authoring.validation.systemColumns
      : NETEZZA_SYSTEM_COLUMNS;

    if (cancellationToken.isCancellationRequested) {
      return this.getStaleTokens(documentUri);
    }
    const useParser =
      options?.useParser ?? text.length <= LARGE_SCRIPT_CHAR_THRESHOLD;
    const scope = useParser
      ? this.resolveDocumentScope(document, text, databaseKind)
      : undefined;
    const identifierRoles = scope
      ? collectIdentifierOccurrencesFromScope(scope)
      : new Map<number, { role: IdentifierSemanticRole }>();
    const aliasNames = new Set<string>();
    const cteNames = new Set<string>();
    let columnNames = new Set<string>();

    // Progressive lex-only: reuse last full-parse name sets so known aliases
    // (e.g. TN) keep green/italic while typing, instead of flashing to default.
    if (!scope) {
      const prior = this.roleNameCache.get(documentUri);
      if (prior) {
        for (const name of prior.aliasNames) {
          aliasNames.add(name);
        }
        for (const name of prior.cteNames) {
          cteNames.add(name);
        }
        for (const name of prior.columnNames) {
          columnNames.add(name);
        }
      }
    }

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

        for (const definition of scope.localDefinitions) {
          if (definition.type.toUpperCase() === "CTE" && definition.name) {
            cteNames.add(definition.name.toUpperCase());
          }
        }

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

        this.roleNameCache.set(documentUri, {
          aliasNames: new Set(aliasNames),
          cteNames: new Set(cteNames),
          columnNames: new Set(columnNames),
        });
      } catch {
        // Metadata lookup failed — proceed with CST map and lexer fallback only
      }
    }

    let previousTokenWasAlias = false;
    // Build comment/string index once — do not call isOffsetInSqlComment per token
    // (even with module cache, concurrent scans can invalidate mid-loop).
    const scanIndex = buildSqlSourceScanIndex(text);

    for (let tokenIndex = 0; tokenIndex < lexResult.tokens.length; tokenIndex++) {
      if (
        tokenIndex % 256 === 0 &&
        cancellationToken.isCancellationRequested
      ) {
        return this.getStaleTokens(documentUri);
      }
      const token = lexResult.tokens[tokenIndex];
      const tokenTypeName = token.tokenType.name;
      const startOffset = token.startOffset;
      const image = token.image;
      if (!image) {
        continue;
      }

      if (scanIndex.isInComment(startOffset)) {
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

        if (
          builtinFunctions.has(word)
          || ((databaseKind === "netezza" || !databaseKind)
            && NETEZZA_BUILTIN_FUNCTIONS.has(word))
        ) {
          typeIdx = TypeIdx.function;
        } else if (
          specialBuiltinValues.has(word)
          || ((databaseKind === "netezza" || !databaseKind)
            && NETEZZA_SPECIAL_BUILTIN_VALUES.has(word))
        ) {
          typeIdx = TypeIdx.enumMember;
        } else if (systemColumns.has(word)) {
          typeIdx = TypeIdx.variable;
          modifierMask = ModifierMask.readonly;
        } else if (isAuthoringType(word, databaseKind)) {
          typeIdx = TypeIdx.type;
        } else if (roleOccurrence) {
          typeIdx = roleToTypeIdx(roleOccurrence.role);
          if (roleOccurrence.role === "alias") {
            modifierMask = ModifierMask.italic;
          }
        } else if (aliasNames.has(word)) {
          typeIdx = TypeIdx.alias;
          modifierMask = ModifierMask.italic;
        } else if (cteNames.has(word)) {
          typeIdx = TypeIdx.table;
        } else if (columnNames.has(word)) {
          typeIdx = TypeIdx.column;
        } else if (previousTokenWasAlias) {
          typeIdx = TypeIdx.column;
        }

        previousTokenWasAlias = aliasNames.has(word) || cteNames.has(word);
      } else if (/^[A-Za-z_]/.test(image)) {
        // Lexer reserved-word tokens (Select, From, With, As, ...) are not all
        // listed in KEYWORD_TOKEN_NAMES — still color them as keywords so the
        // progressive lex-only pass paints correct lines after Enter.
        typeIdx = TypeIdx.keyword;
        previousTokenWasAlias = false;
      } else if (tokenTypeName !== "Dot") {
        previousTokenWasAlias = false;
      }

      if (typeIdx === undefined) {
        continue;
      }

      // Chevrotain lines/columns are 1-based; SemanticTokensBuilder is 0-based.
      // Avoid document.positionAt in the hot loop (can be O(n) per call).
      const line = Math.max(0, (token.startLine ?? 1) - 1);
      const character = Math.max(0, (token.startColumn ?? 1) - 1);
      builder.push(line, character, length, typeIdx, modifierMask);
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
