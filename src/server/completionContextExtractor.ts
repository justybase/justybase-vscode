import { SqlLexer } from "../sqlParser";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DatabaseKind } from "../contracts/database";
import { SqlParser } from "../sql/sqlParser";
import { stripComments } from "../providers/parsers/commentStripper";
import { simpleHash } from "../providers/parsers/hashUtils";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { parseSemanticScopeWithParser } from "../providers/parsers/parserSqlContext";
import { toDocumentParseRequest } from "./documentParseRequest";
import { parseVariables } from "../providers/parsers/variableParser";
import { endsInsideUnclosedParen } from "../core/parenAwareText";
import { parseAlterTableContext } from "./completionAlterTableContext";
import { normalizeDialectQuotedIdentifiers, parseTablePathFragment, stripQuotes } from "./completionDialectAdapter";
import { shouldTreatSingleDotPathAsSchema, supportsDoubleDotPath } from "./completionPathUtils";
import {
  extractQualifierPathBeforeMultiply,
  isIdentifierToken,
} from "./completionCstUtils";
import {
  isPersistentDocumentDefinition,
  mergeLocalDefinitions,
} from "./completionLocalDefinitionUtils";
import type {
  FromJoinContext,
  ParsedContext,
  StatementBoundary,
  TableTargetPathContext,
} from "./completionTypes";
import type { Position } from "vscode-languageserver/node";

/**
 * Extracts parser-derived completion context and statement-local cursor state.
 */
export class CompletionContextExtractor {
  private readonly parsedCache = new Map<string, ParsedContext>();
  /** Statement boundaries per document version (no full-text SHA-1). */
  private readonly statementCache = new Map<string, StatementBoundary[]>();
  private readonly MAX_CACHE_SIZE = 50;
  private readonly MAX_STATEMENT_CACHE_SIZE = 100;
  private readonly PARSER_PLACEHOLDER = "__JB_COMPLETION__";

  constructor(private readonly parseSession?: DocumentParseSession) {}

  public getParsedContext(
    document: TextDocument,
    databaseKind?: DatabaseKind,
    cursorOffset?: number,
  ): ParsedContext {
    const text = document.getText();
    const normalizedText = normalizeDialectQuotedIdentifiers(text, databaseKind);
    const normalizedCursorOffset =
      cursorOffset === undefined
        ? undefined
        : Math.max(0, Math.min(cursorOffset, normalizedText.length));

    const statementBoundary =
      normalizedCursorOffset !== undefined
        ? this.getStatementAtPosition(
            normalizedText,
            normalizedCursorOffset,
            document.uri,
            document.version,
          )
        : null;

    const persistentScopeText = (() => {
      if (normalizedCursorOffset === undefined) {
        return stripComments(normalizedText);
      }
      const boundary = statementBoundary?.start ?? normalizedText.length;
      return stripComments(normalizedText.substring(0, boundary));
    })();

    const cursorCacheKey = databaseKind === "oracle"
      ? normalizedCursorOffset ?? "full"
      : "shared";
    const contentHash = simpleHash(
      `${databaseKind ?? "default"}:${persistentScopeText}:${statementBoundary?.start ?? "full"}:${cursorCacheKey}`,
    );

    const cleanText = stripComments(normalizedText);
    const parsedVariables = (() => {
      try {
        return parseVariables(cleanText);
      } catch {
        return [];
      }
    })();

    const cached = this.parsedCache.get(contentHash);
    if (cached) {
      return {
        ...cached,
        cleanText,
        variables: parsedVariables,
      };
    }

    const allLocalDefs = (() => {
      try {
        const scopeText = databaseKind === "oracle" ? cleanText : persistentScopeText;
        return this.getSemanticScope(
          document,
          scopeText,
          undefined,
          databaseKind,
        ).localDefinitions;
      } catch {
        return [];
      }
    })();
    const localDefs = (() => {
      const persistentDefinitions = allLocalDefs.filter((def) =>
        isPersistentDocumentDefinition(def),
      );
      if (databaseKind !== "oracle" || normalizedCursorOffset === undefined) {
        return persistentDefinitions;
      }

      try {
        const visibleDefinitions = this.getSemanticScope(
          document,
          cleanText,
          normalizedCursorOffset,
          databaseKind,
        ).visibleLocalDefinitions;
        return mergeLocalDefinitions(persistentDefinitions, visibleDefinitions);
      } catch {
        return persistentDefinitions;
      }
    })();

    const parsed: ParsedContext = {
      contentHash,
      cleanText,
      allLocalDefs,
      localDefs,
      variables: parsedVariables,
    };

    if (this.parsedCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.parsedCache.keys().next().value;
      if (firstKey !== undefined) {
        this.parsedCache.delete(firstKey);
      }
    }

    this.parsedCache.set(contentHash, parsed);
    return parsed;
  }

  public getVisibleLocalDefinitionsForFromJoin(
    localDefs: import("../providers/types").LocalDefinition[],
    statementSql: string,
    statementOffset: number,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): import("../providers/types").LocalDefinition[] {
    if (!statementSql) {
      return localDefs;
    }

    try {
      const parserFriendly = this.prepareParserFriendlySql(
        statementSql,
        statementOffset,
        databaseKind,
      );
      const visibleDefsInPrefix = this.getSemanticScopeFromParts(
        documentUri,
        documentVersion,
        parserFriendly.sql,
        parserFriendly.cursorOffset,
        databaseKind,
      ).visibleLocalDefinitions;
      return mergeLocalDefinitions(localDefs, visibleDefsInPrefix);
    } catch {
      return localDefs;
    }
  }

  private getSemanticScope(
    document: TextDocument,
    sql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ) {
    if (this.parseSession) {
      return this.parseSession.getSemanticScope({
        ...toDocumentParseRequest(document, sql, databaseKind),
        cursorOffset,
      });
    }
    return parseSemanticScopeWithParser(sql, cursorOffset, databaseKind);
  }

  private getSemanticScopeFromParts(
    documentUri: string | undefined,
    documentVersion: number | undefined,
    sql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ) {
    if (this.parseSession && documentUri !== undefined && documentVersion !== undefined) {
      return this.parseSession.getSemanticScope({
        documentUri,
        documentVersion,
        sql,
        cursorOffset,
        databaseKind,
      });
    }
    return parseSemanticScopeWithParser(sql, cursorOffset, databaseKind);
  }

  public getStatementAtPosition(
    text: string,
    offset: number,
    documentUri?: string,
    documentVersion?: number,
  ): StatementBoundary | null {
    if (documentUri !== undefined && documentVersion !== undefined) {
      const cacheKey = `${documentUri}:${documentVersion}`;
      let cached = this.statementCache.get(cacheKey);
      if (!cached) {
        cached = SqlParser.splitStatementsWithPositions(text).map(
          (statement) => ({
            sql: statement.sql,
            start: statement.startOffset,
            end: statement.endOffset,
          }),
        );

        if (this.statementCache.size >= this.MAX_STATEMENT_CACHE_SIZE) {
          const firstKey = this.statementCache.keys().next().value;
          if (firstKey !== undefined) {
            this.statementCache.delete(firstKey);
          }
        }

        this.statementCache.set(cacheKey, cached);
      }

      const inRange = cached.find(
        (statement) => offset >= statement.start && offset <= statement.end + 1,
      );
      if (inRange) {
        return inRange;
      }
    }

    const statement =
      documentUri !== undefined && documentVersion !== undefined
        ? SqlParser.getStatementAtPosition(text, offset, {
            documentId: documentUri,
            version: documentVersion,
          })
        : SqlParser.getStatementAtPosition(text, offset);
    if (!statement) {
      return null;
    }

    return {
      sql: statement.sql,
      start: statement.start,
      end: statement.end,
    };
  }

  public parseFromJoinContext(
    statementPrefix: string,
    linePrefix: string,
    prevLine: string,
    databaseKind?: DatabaseKind,
  ): FromJoinContext | undefined {
    const normalizedStatementPrefix = normalizeDialectQuotedIdentifiers(
      statementPrefix,
      databaseKind,
    );
    const normalizedLinePrefix = normalizeDialectQuotedIdentifiers(
      linePrefix,
      databaseKind,
    );
    const normalizedPrevLine = normalizeDialectQuotedIdentifiers(
      prevLine,
      databaseKind,
    );

    const sameLineFragment =
      this.getSameLineFromJoinFragment(normalizedLinePrefix);
    const hasCompletedSameLineTarget =
      sameLineFragment !== undefined &&
      /\s$/.test(sameLineFragment) &&
      sameLineFragment.trim().length > 0;
    const hasCompletedMultiLineTarget =
      /\s$/.test(normalizedLinePrefix) &&
      /(?:FROM|JOIN)\s*$/i.test(normalizedPrevLine) &&
      normalizedLinePrefix.trim().length > 0;
    if (hasCompletedSameLineTarget || hasCompletedMultiLineTarget) {
      return undefined;
    }

    if (
      !this.isFromJoinCursorContext(normalizedLinePrefix, normalizedPrevLine)
    ) {
      return undefined;
    }

    const lexResult = SqlLexer.tokenize(normalizedStatementPrefix);
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
      return this.parseFromJoinContextFromLineFallback(
        normalizedLinePrefix,
        normalizedPrevLine,
        databaseKind,
      );
    }

    const tokens = lexResult.tokens;
    const boundaryTokens = new Set([
      "Where",
      "On",
      "Group",
      "Having",
      "Order",
      "Limit",
      "Union",
      "Intersect",
      "Except",
      "Semicolon",
    ]);

    let fromJoinIndex = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tokenName = tokens[i].tokenType.name;
      if (tokenName === "From" || tokenName === "Join") {
        fromJoinIndex = i;
        break;
      }
      if (boundaryTokens.has(tokenName)) {
        return undefined;
      }
    }

    if (fromJoinIndex === -1) {
      return this.parseFromJoinContextFromLineFallback(
        normalizedLinePrefix,
        normalizedPrevLine,
        databaseKind,
      );
    }

    const fromJoinToken = tokens[fromJoinIndex];
    const fragmentStart =
      (fromJoinToken.endOffset ?? fromJoinToken.startOffset ?? 0) + 1;
    const fragment = normalizedStatementPrefix.substring(fragmentStart);
    const parsedFragment = parseTablePathFragment(fragment, databaseKind);
    if (!parsedFragment) {
      return this.parseFromJoinContextFromLineFallback(
        normalizedLinePrefix,
        normalizedPrevLine,
        databaseKind,
      );
    }
    return parsedFragment;
  }

  public parseFromJoinContextFromLineFallback(
    linePrefix: string,
    prevLine: string,
    databaseKind?: DatabaseKind,
  ): FromJoinContext | undefined {
    const sameLineFragment = this.getSameLineFromJoinFragment(linePrefix);
    if (sameLineFragment !== undefined) {
      const parsed = parseTablePathFragment(
        sameLineFragment.replace(/^\s+/, ""),
        databaseKind,
      );
      if (parsed) {
        return parsed;
      }
    }

    if (/(?:FROM|JOIN)\s*$/i.test(prevLine)) {
      const parsed = parseTablePathFragment(
        linePrefix.replace(/^\s+/, ""),
        databaseKind,
      );
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  public parseUpdateDropTruncateContext(
    statementPrefix: string,
    databaseKind?: DatabaseKind,
  ): TableTargetPathContext | undefined {
    const normalizedStatementPrefix = normalizeDialectQuotedIdentifiers(
      statementPrefix,
      databaseKind,
    );
    const lexResult = SqlLexer.tokenize(normalizedStatementPrefix);
    if (lexResult.tokens.length === 0) {
      return undefined;
    }

    const tokens = lexResult.tokens;
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      const tokenName = token.tokenType.name;

      if (
        tokenName === "Into" &&
        tokens[index - 1]?.tokenType.name === "Insert"
      ) {
        const fragmentStart = (token.endOffset ?? token.startOffset ?? 0) + 1;
        const parsed = parseTablePathFragment(
          normalizedStatementPrefix.substring(fragmentStart),
          databaseKind,
        );
        if (parsed) {
          return { path: parsed, targetType: "table" };
        }
        continue;
      }

      if (
        tokenName === "Call" ||
        tokenName === "Execute" ||
        tokenName === "Exec"
      ) {
        const fragmentStart = (token.endOffset ?? token.startOffset ?? 0) + 1;
        const parsed = parseTablePathFragment(
          normalizedStatementPrefix.substring(fragmentStart),
          databaseKind,
        );
        if (parsed) {
          return { path: parsed, targetType: "procedure" };
        }
        continue;
      }

      if (tokenName === "Update") {
        const hasSetAfter = tokens
          .slice(index + 1)
          .some((nextToken) => nextToken.tokenType.name === "Set");
        if (hasSetAfter) {
          continue;
        }

        const fragmentStart = (token.endOffset ?? token.startOffset ?? 0) + 1;
        const parsed = parseTablePathFragment(
          normalizedStatementPrefix.substring(fragmentStart),
          databaseKind,
        );
        if (parsed) {
          return { path: parsed, targetType: "table" };
        }
        continue;
      }

      if (tokenName === "For") {
        const synonymIndex = tokens
          .slice(0, index)
          .map((candidate) => candidate.tokenType.name)
          .lastIndexOf("Synonym");
        if (synonymIndex >= 0) {
          let actionIndex = synonymIndex - 1;
          if (
            tokens[actionIndex]?.tokenType.name === "Replace" &&
            tokens[actionIndex - 1]?.tokenType.name === "Or" &&
            tokens[actionIndex - 2]?.tokenType.name === "Create"
          ) {
            actionIndex -= 2;
          }

          const actionTokenName = tokens[actionIndex]?.tokenType.name;
          if (actionTokenName === "Create" || actionTokenName === "Alter") {
            const fragmentStart =
              (token.endOffset ?? token.startOffset ?? 0) + 1;
            const parsed = parseTablePathFragment(
              normalizedStatementPrefix.substring(fragmentStart),
              databaseKind,
            );
            if (parsed) {
              const synonymPath =
                parsed.kind === "db_dot" &&
                supportsDoubleDotPath(databaseKind) &&
                (databaseKind === "netezza" ||
                  !shouldTreatSingleDotPathAsSchema(databaseKind))
                  ? {
                      kind: "db_double_dot" as const,
                      dbName: parsed.dbName,
                      partial: parsed.partial,
                    }
                  : parsed;
              return { path: synonymPath, targetType: "table" };
            }
          }
        }
        continue;
      }

      let targetType: TableTargetPathContext["targetType"] | undefined;
      if (tokenName === "Table") {
        targetType = "table";
      } else if (tokenName === "View") {
        targetType = "view";
      } else if (tokenName === "Procedure") {
        targetType = "procedure";
      }

      if (targetType) {
        let actionIndex = index - 1;
        if (
          tokenName === "Table" &&
          (tokens[actionIndex]?.tokenType.name === "Temp" ||
            tokens[actionIndex]?.tokenType.name === "Temporary")
        ) {
          actionIndex -= 1;
        }

        if (
          tokens[actionIndex]?.tokenType.name === "Replace" &&
          tokens[actionIndex - 1]?.tokenType.name === "Or" &&
          tokens[actionIndex - 2]?.tokenType.name === "Create"
        ) {
          actionIndex -= 2;
        }

        const actionTokenName = tokens[actionIndex]?.tokenType.name;
        const supportsCreateAction =
          actionTokenName === "Create" &&
          (targetType === "table" || targetType === "view");
        const isValidAction =
          actionTokenName === "Drop" ||
          actionTokenName === "Alter" ||
          supportsCreateAction ||
          (tokenName === "Table" &&
            (actionTokenName === "Truncate" || actionTokenName === "Groom"));

        if (!isValidAction) {
          continue;
        }

        if (actionTokenName === "Alter" && tokenName === "Table") {
          const alterContext = parseAlterTableContext(
            normalizedStatementPrefix,
            normalizedStatementPrefix.length,
            databaseKind,
          );
          if (alterContext?.kind === "action") {
            continue;
          }
          if (alterContext?.kind === "table_target") {
            return { path: alterContext.path, targetType };
          }
        }

        const fragmentStart = (token.endOffset ?? token.startOffset ?? 0) + 1;
        const parsed = parseTablePathFragment(
          normalizedStatementPrefix.substring(fragmentStart),
          databaseKind,
        );
        if (parsed) {
          return { path: parsed, targetType };
        }
        continue;
      }

      if (
        tokenName === "Select" ||
        tokenName === "Insert" ||
        tokenName === "Delete" ||
        tokenName === "With" ||
        tokenName === "Semicolon"
      ) {
        break;
      }
    }

    return undefined;
  }

  public prepareParserFriendlySql(
    sql: string,
    cursorOffset: number,
    databaseKind?: DatabaseKind,
  ): { sql: string; cursorOffset: number } {
    let normalizedSql = normalizeDialectQuotedIdentifiers(sql, databaseKind);
    let normalizedCursorOffset = cursorOffset;

    const incompleteBracketMatch = /\.\s*\[[^\]\r\n,)]*$/.exec(
      normalizedSql.substring(0, normalizedCursorOffset),
    );
    if (incompleteBracketMatch && incompleteBracketMatch.index !== undefined) {
      const dotIndex = normalizedCursorOffset - incompleteBracketMatch[0].length;
      const replacement = `.${this.PARSER_PLACEHOLDER}`;
      normalizedSql =
        normalizedSql.substring(0, dotIndex) +
        replacement +
        normalizedSql.substring(normalizedCursorOffset);
      normalizedCursorOffset = dotIndex + replacement.length;
    }

    return {
      sql: this.createParserFriendlyText(normalizedSql, normalizedCursorOffset),
      cursorOffset: normalizedCursorOffset,
    };
  }

  public extractCurrentIdentifierPrefix(linePrefix: string): string {
    const match = linePrefix.match(/([A-Za-z_][A-Za-z0-9_$"]*)$/);
    return match ? stripQuotes(match[1]) : "";
  }

  public extractQualifierColumnContext(
    linePrefix: string,
  ): { qualifier: string; columnPrefix: string } | undefined {
    const partialMatch = linePrefix.match(
      /(\[[^\]\r\n]+\]|"[^"\r\n]+"|[A-Za-z_][A-Za-z0-9_$"]*)\.([A-Za-z_][A-Za-z0-9_$"]*)$/,
    );
    if (partialMatch) {
      return {
        qualifier: stripQuotes(partialMatch[1]),
        columnPrefix: stripQuotes(partialMatch[2]),
      };
    }

    const qualifier = this.extractQualifierBeforeDot(linePrefix);
    if (qualifier) {
      return { qualifier, columnPrefix: "" };
    }

    return undefined;
  }

  public extractQualifierBeforeDot(linePrefix: string): string | undefined {
    const dottedQualifierMatch = linePrefix.match(
      /(\[[^\]\r\n]+\]|"[^"\r\n]+"|[A-Za-z0-9_$"]+)\.$/,
    );
    if (dottedQualifierMatch) {
      return stripQuotes(dottedQualifierMatch[1]);
    }

    const bracketQualifierMatch = linePrefix.match(
      /(\[[^\]\r\n]+\]|"[^"\r\n]+"|[A-Za-z0-9_$"]+)\.\s*\[[^\]\r\n]*$/,
    );
    if (bracketQualifierMatch) {
      return stripQuotes(bracketQualifierMatch[1]);
    }

    if (!linePrefix.endsWith(".")) {
      return undefined;
    }

    let index = linePrefix.length - 2;
    while (index >= 0 && this.isIdentifierCharacter(linePrefix[index])) {
      index--;
    }

    const qualifier = linePrefix
      .substring(index + 1, linePrefix.length - 1)
      .trim();
    return qualifier || undefined;
  }

  public extractQualifierBeforeDotAndStar(
    linePrefix: string,
  ): { qualifier: string; fullMatch: string } | undefined {
    const lexResult = SqlLexer.tokenize(linePrefix);
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
      return undefined;
    }

    const tokens = lexResult.tokens;
    const starIndex = tokens.length - 1;
    if (tokens[starIndex].tokenType.name !== "Multiply") {
      return undefined;
    }

    const dottedQualifier = extractQualifierPathBeforeMultiply(tokens, starIndex);
    if (dottedQualifier) {
      return {
        qualifier: dottedQualifier.qualifier,
        fullMatch: linePrefix.substring(Math.max(0, dottedQualifier.startOffset)),
      };
    }

    const identifierToken = tokens[starIndex - 1];
    if (!isIdentifierToken(identifierToken)) {
      return undefined;
    }

    const boundaryOffset = (identifierToken.startOffset ?? 0) - 1;
    if (boundaryOffset >= 0) {
      const boundaryChar = linePrefix[boundaryOffset];
      if (boundaryChar && !/[\s,(]/.test(boundaryChar)) {
        return undefined;
      }
    }

    return {
      qualifier: stripQuotes(identifierToken.image),
      fullMatch: linePrefix.substring(
        Math.max(0, identifierToken.startOffset ?? 0),
      ),
    };
  }

  public getLinePrefix(document: TextDocument, position: Position): string {
    const fullLine = this.getLineText(document, position.line);
    return fullLine.substring(0, Math.min(position.character, fullLine.length));
  }

  public getLineText(document: TextDocument, line: number): string {
    if (line < 0) {
      return "";
    }
    const lines = document.getText().split(/\r?\n/);
    return lines[line] || "";
  }

  private getSameLineFromJoinFragment(linePrefix: string): string | undefined {
    const matches = Array.from(linePrefix.matchAll(/\b(?:FROM|JOIN)\b/gi));
    const lastMatch = matches[matches.length - 1];
    if (!lastMatch || lastMatch.index === undefined) {
      return undefined;
    }
    return linePrefix.substring(lastMatch.index + lastMatch[0].length);
  }

  private isFromJoinCursorContext(
    linePrefix: string,
    prevLine: string,
  ): boolean {
    const sameLine = this.getSameLineFromJoinFragment(linePrefix) !== undefined;
    const multiLine = /(?:FROM|JOIN)\s*$/i.test(prevLine);
    return sameLine || multiLine;
  }

  private createParserFriendlyText(text: string, cursorOffset: number): string {
    if (cursorOffset <= 0 || cursorOffset > text.length) {
      return text;
    }

    const prevChar = text[cursorOffset - 1];
    const nextChar = cursorOffset < text.length ? text[cursorOffset] : "";
    if (prevChar === "." && !this.isIdentifierCharacter(nextChar)) {
      return `${text.substring(0, cursorOffset)}${this.PARSER_PLACEHOLDER}${text.substring(cursorOffset)}`;
    }

    return text;
  }

  private isIdentifierCharacter(char: string): boolean {
    if (!char) {
      return false;
    }
    return /[A-Za-z0-9_$"]/.test(char);
  }

  /**
   * Detect INSERT INTO table (column-list) context for column completion.
   */
  public parseInsertColumnListContext(
    statementPrefix: string,
    databaseKind?: DatabaseKind,
  ): { tablePath: string; database?: string; schema?: string; table: string } | undefined {
    const normalized = normalizeDialectQuotedIdentifiers(
      statementPrefix,
      databaseKind,
    );
    const insertIntoMatch = normalized.match(/\bINSERT\s+INTO\s+/i);
    if (!insertIntoMatch || insertIntoMatch.index === undefined) {
      return undefined;
    }

    let cursor = insertIntoMatch.index + insertIntoMatch[0].length;
    const tableMatch = normalized.slice(cursor).match(/^[\w".]+(?:\.[\w".]+)*/);
    if (!tableMatch) {
      return undefined;
    }

    const tablePath = tableMatch[0];
    cursor += tablePath.length;

    while (cursor < normalized.length && /\s/.test(normalized[cursor] ?? "")) {
      cursor += 1;
    }
    if (normalized[cursor] !== "(") {
      return undefined;
    }
    if (!endsInsideUnclosedParen(normalized, cursor)) {
      return undefined;
    }
    const parsed = parseTablePathFragment(tablePath, databaseKind);
    if (!parsed) {
      return undefined;
    }

    if (parsed.kind === "db_double_dot") {
      return {
        tablePath,
        database: parsed.dbName,
        table: stripQuotes(parsed.partial || tablePath.split(".").pop() || ""),
      };
    }
    if (parsed.kind === "db_dot") {
      return {
        tablePath,
        database: parsed.dbName,
        table: stripQuotes(parsed.partial || tablePath.split(".").pop() || ""),
      };
    }
    if (parsed.kind === "db_schema_dot") {
      return {
        tablePath,
        database: parsed.dbName,
        schema: parsed.schemaName,
        table: stripQuotes(parsed.partial || tablePath.split(".").pop() || ""),
      };
    }
    if (parsed.kind === "from_join_name") {
      const parts = tablePath.split(".");
      const table = stripQuotes(parts[parts.length - 1] ?? "");
      const schema =
        parts.length >= 2 ? stripQuotes(parts[parts.length - 2] ?? "") : undefined;
      return { tablePath, schema, table };
    }

    return undefined;
  }
}
