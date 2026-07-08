import { InlayHint, InlayHintKind, Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SqlParser } from "../sql/sqlParser";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { parseSemanticScopeWithParser } from "../providers/parsers/parserSqlContext";
import { toDocumentParseRequest } from "./documentParseRequest";
import type { AliasInfo } from "../providers/types";
import type {
  MetadataContextResponse,
  MetadataTableInfoResponse,
} from "../lsp/protocol";

interface QualifiedColumnRef {
  qualifier: string;
  column: string;
  columnEndOffset: number;
}

export interface InlayHintMetadataProvider {
  getContext(documentUri: string): Promise<MetadataContextResponse>;
  getCachedTableInfo(
    documentUri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataTableInfoResponse | undefined>;
}

export class LspInlayHintEngine {
  public constructor(
    private readonly metadataProvider: InlayHintMetadataProvider,
    private readonly parseSession?: DocumentParseSession,
  ) {}

  public async provideInlayHints(
    document: TextDocument,
    range: Range,
    isCancellationRequested?: () => boolean,
  ): Promise<InlayHint[]> {
    const context = await this.metadataProvider.getContext(document.uri);
    if (isCancellationRequested?.()) {
      return [];
    }

    const effectiveDb = context.effectiveDatabase;
    const databaseKind = context.databaseKind;
    const fullText = document.getText();
    const rangeStartOffset = document.offsetAt(range.start);
    const rangeEndOffset = document.offsetAt(range.end);
    const hints: InlayHint[] = [];
    const dedupe = new Set<string>();
    const statements = SqlParser.splitStatementsWithPositions(fullText);
    const documentParseRequest = toDocumentParseRequest(
      document,
      fullText,
      databaseKind,
    );

    interface PendingLookup {
      statementStart: number;
      reference: QualifiedColumnRef;
      database: string;
      table: string;
      schema?: string;
      cacheKey: string;
    }

    const pendingLookups: PendingLookup[] = [];
    const columnTypeCache = new Map<string, Map<string, string>>();
    const lookupGroups = new Map<string, PendingLookup>();

    for (const statement of statements) {
      if (isCancellationRequested?.()) {
        return hints;
      }

      const statementStart = statement.startOffset;
      const statementEndExclusive = statement.endOffset + 1;
      if (
        statementEndExclusive < rangeStartOffset ||
        statementStart > rangeEndOffset
      ) {
        continue;
      }

      const qualifiedRefs = this.findQualifiedColumns(statement.sql).filter(
        (reference) => {
          const absoluteColumnEnd = statementStart + reference.columnEndOffset;
          return (
            absoluteColumnEnd >= rangeStartOffset &&
            absoluteColumnEnd <= rangeEndOffset
          );
        },
      );

      if (qualifiedRefs.length === 0) {
        continue;
      }

      const aliasBindings = this.getStatementAliasBindings(
        documentParseRequest,
        this.resolveStatementScopeCursorOffset(fullText, statement),
      ).preferredAliasBindings;

      for (const reference of qualifiedRefs) {
        const binding = this.resolveAliasBinding(
          reference.qualifier,
          aliasBindings,
        );
        if (!binding) {
          continue;
        }

        const database = binding.db || effectiveDb;
        if (!database) {
          continue;
        }

        const cacheKey = `${database}|${binding.schema ?? ""}|${binding.table}`;
        const lookup = {
          statementStart,
          reference,
          database,
          table: binding.table,
          schema: binding.schema,
          cacheKey,
        };
        pendingLookups.push(lookup);
        lookupGroups.set(cacheKey, lookup);
      }
    }

    const fetchPromises = Array.from(lookupGroups.entries()).map(async ([
      cacheKey,
      lookup,
    ]) => {
      const tableInfo = await this.metadataProvider.getCachedTableInfo(
        document.uri,
        lookup.database,
        lookup.table,
        lookup.schema,
      );
      columnTypeCache.set(cacheKey, this.buildColumnTypeMap(tableInfo));
    });

    await Promise.all(fetchPromises);

    if (isCancellationRequested?.()) {
      return hints;
    }

    for (const lookup of pendingLookups) {
      if (isCancellationRequested?.()) {
        return hints;
      }

      const columnType = this.findColumnType(
        columnTypeCache.get(lookup.cacheKey),
        lookup.reference.column,
      );
      if (!columnType) {
        continue;
      }

      const absoluteColumnEnd =
        lookup.statementStart + lookup.reference.columnEndOffset;
      const dedupeKey = `${absoluteColumnEnd}|${columnType}`;
      if (dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);

      hints.push({
        position: document.positionAt(absoluteColumnEnd),
        label: ` ${columnType}`,
        kind: InlayHintKind.Type,
        paddingLeft: true,
        tooltip: `${lookup.reference.qualifier}.${lookup.reference.column}: ${columnType}`,
      });
    }

    return hints;
  }

  private resolveAliasBinding(
    qualifier: string,
    aliasBindings: Map<string, AliasInfo>,
  ): AliasInfo | undefined {
    const normalizedQualifier = this.stripQuotes(qualifier).toUpperCase();
    return aliasBindings.get(normalizedQualifier);
  }

  private findQualifiedColumns(statementSql: string): QualifiedColumnRef[] {
    const pattern =
      /("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/g;
    const matches: QualifiedColumnRef[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(statementSql)) !== null) {
      const fullMatch = match[0];
      const qualifier = this.stripQuotes(match[1]);
      const column = this.stripQuotes(match[2]);
      const dotIndex = fullMatch.lastIndexOf(".");
      if (dotIndex === -1) {
        continue;
      }

      const afterDot = fullMatch.substring(dotIndex + 1);
      const leadingWhitespace = afterDot.match(/^\s*/)?.[0].length || 0;
      const columnStartOffset =
        match.index + dotIndex + 1 + leadingWhitespace;
      const columnEndOffset = columnStartOffset + match[2].length;

      matches.push({
        qualifier,
        column,
        columnEndOffset,
      });
    }

    return matches;
  }

  private buildColumnTypeMap(
    tableInfo: MetadataTableInfoResponse | undefined,
  ): Map<string, string> {
    const columnTypes = new Map<string, string>();
    if (!tableInfo || tableInfo.columns.length === 0) {
      return columnTypes;
    }

    for (const column of tableInfo.columns) {
      const columnType = column.type?.trim();
      if (columnType && columnType.length > 0) {
        columnTypes.set(column.name.toUpperCase(), columnType);
      }
    }

    return columnTypes;
  }

  private findColumnType(
    columnTypes: Map<string, string> | undefined,
    columnName: string,
  ): string | undefined {
    if (!columnTypes || columnTypes.size === 0) {
      return undefined;
    }

    return columnTypes.get(columnName.toUpperCase());
  }

  private stripQuotes(identifier: string): string {
    if (
      identifier.length >= 2 &&
      identifier.startsWith('"') &&
      identifier.endsWith('"')
    ) {
      return identifier.slice(1, -1);
    }
    return identifier;
  }

  private resolveStatementScopeCursorOffset(
    fullText: string,
    statement: { startOffset: number; endOffset: number },
  ): number {
    const { startOffset, endOffset } = statement;
    let cursorOffset = endOffset;

    if (cursorOffset < fullText.length && fullText[cursorOffset] === ";") {
      cursorOffset -= 1;
    } else if (cursorOffset > startOffset && cursorOffset === fullText.length) {
      cursorOffset -= 1;
    }

    while (
      cursorOffset > startOffset &&
      /\s/.test(fullText.charAt(cursorOffset))
    ) {
      cursorOffset -= 1;
    }

    return Math.max(startOffset, cursorOffset);
  }

  private getStatementAliasBindings(
    parseRequest: ReturnType<typeof toDocumentParseRequest>,
    cursorOffset: number,
  ) {
    if (this.parseSession) {
      return this.parseSession.getSemanticScope({
        ...parseRequest,
        cursorOffset,
      });
    }
    return parseSemanticScopeWithParser(
      parseRequest.sql,
      cursorOffset,
      parseRequest.databaseKind,
    );
  }
}
