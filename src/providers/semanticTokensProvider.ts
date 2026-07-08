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

  constructor(
    private readonly metadataCache?: MetadataCache,
    private readonly connectionManager?: ConnectionManager,
    private readonly parseSession?: DocumentParseSession,
  ) {}

  getLegend(): vscode.SemanticTokensLegend {
    return LEGEND;
  }

  refresh(): void {
    this._onDidChangeSemanticTokens.fire();
  }

  dispose(): void {
    this._onDidChangeSemanticTokens.dispose();
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.SemanticTokens {
    const text = document.getText();

    try {
      return this.tokenize(text, document);
    } catch {
      return new vscode.SemanticTokens(new Uint32Array(0));
    }
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
  ): vscode.SemanticTokens {
    const lexResult = SqlLexer.tokenize(text);
    const builder = new vscode.SemanticTokensBuilder(LEGEND);

    const documentUri = document.uri.toString();
    const databaseKind = this.connectionManager?.getExecutionDatabaseKind(
      documentUri,
    );

    const scope = this.resolveDocumentScope(document, text, databaseKind);

    const identifierRoles = collectIdentifierOccurrencesFromScope(scope);
    const aliasNames = new Set<string>();
    let columnNames = new Set<string>();

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
        const connectionName = this.connectionManager.getConnectionForExecution(documentUri);
        if (connectionName) {
          const effectiveDatabase = this.resolveEffectiveDatabase(documentUri, connectionName);
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
      // Parser failed — proceed with CST map and lexer fallback only
    }

    let previousTokenWasAlias = false;

    for (const token of lexResult.tokens) {
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
