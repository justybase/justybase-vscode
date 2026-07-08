import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connectionManager";
import type { MetadataCache } from "../metadataCache";
import type { DatabaseKind } from "../contracts/database";
import { getCachedColumnsFromMetadataCacheAsync } from "../metadata/columnCacheLookup";
import type { ColumnMetadata } from "../metadata/types";
import { SqlParser } from "../sql/sqlParser";
import { parseSemanticScopeWithParser } from "./parsers/parserSqlContext";
import type { AliasInfo } from "./types";
import { getExtensionConfiguration } from "../compatibility/configuration";

interface QualifiedColumnRef {
  qualifier: string;
  column: string;
  columnEndOffset: number;
}

export class NetezzaColumnTypeInlayHintsProvider
  implements vscode.InlayHintsProvider
{
  constructor(
    private readonly metadataCache: MetadataCache,
    private readonly connectionManager: ConnectionManager,
  ) {}

  public async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const showInlineTypeHints =
      getExtensionConfiguration("sql").get<boolean>(
        "showInlineTypeHints",
        false,
      ) ?? false;
    if (!showInlineTypeHints || token.isCancellationRequested) {
      return [];
    }

    const documentUri = document.uri.toString();
    const connectionName =
      this.connectionManager.getConnectionForExecution(documentUri) ||
      this.connectionManager.getActiveConnectionName() ||
      undefined;
    if (!connectionName) {
      return [];
    }

    const effectiveDb =
      (await this.connectionManager.getEffectiveDatabase(documentUri)) ||
      undefined;
    const databaseKind =
      this.connectionManager.getExecutionDatabaseKind(documentUri);
    const fullText = document.getText();
    const rangeStartOffset = document.offsetAt(range.start);
    const rangeEndOffset = document.offsetAt(range.end);

    const hints: vscode.InlayHint[] = [];
    const dedupe = new Set<string>();
    const statements = SqlParser.splitStatementsWithPositions(fullText);

    interface PendingLookup {
      statementStart: number;
      reference: QualifiedColumnRef;
      dbName: string;
      schemaName?: string;
      tableName: string;
      cacheKey: string;
    }

    const pendingLookups: PendingLookup[] = [];
    const lookupGroups = new Map<string, PendingLookup>();
    const columnTypeCache = new Map<string, Map<string, string>>();

    for (const statement of statements) {
      if (token.isCancellationRequested) {
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

      const aliasBindings = parseSemanticScopeWithParser(
        statement.sql,
        undefined,
        databaseKind,
      ).preferredAliasBindings;

      for (const reference of qualifiedRefs) {
        const binding = this.resolveAliasBinding(
          reference.qualifier,
          aliasBindings,
        );
        if (!binding) {
          continue;
        }

        const dbName = binding.db || effectiveDb;
        if (!dbName) {
          continue;
        }

        const cacheKey = `${dbName}|${binding.schema ?? ""}|${binding.table}`;
        const lookup = {
          statementStart,
          reference,
          dbName,
          schemaName: binding.schema,
          tableName: binding.table,
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
      const columns = await this.getCachedColumns(
        connectionName,
        lookup.dbName,
        lookup.schemaName,
        lookup.tableName,
        databaseKind,
      );
      columnTypeCache.set(cacheKey, this.buildColumnTypeMap(columns));
    });

    await Promise.all(fetchPromises);

    for (const lookup of pendingLookups) {
      if (token.isCancellationRequested) {
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

      const hint = new vscode.InlayHint(
        document.positionAt(absoluteColumnEnd),
        ` ${columnType}`,
        vscode.InlayHintKind.Type,
      );
      hint.paddingLeft = true;
      hint.tooltip = `${lookup.reference.qualifier}.${lookup.reference.column}: ${columnType}`;
      hints.push(hint);
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
      const columnStartOffset = match.index + dotIndex + 1 + leadingWhitespace;
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
    columns: ColumnMetadata[] | undefined,
  ): Map<string, string> {
    const columnTypes = new Map<string, string>();
    if (!columns) {
      return columnTypes;
    }

    for (const column of columns) {
      const columnType = this.extractColumnType(column);
      if (columnType) {
        columnTypes.set(this.extractColumnName(column).toUpperCase(), columnType);
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

  private async getCachedColumns(
    connectionName: string,
    dbName: string,
    schemaName: string | undefined,
    tableName: string,
    databaseKind?: DatabaseKind,
  ): Promise<ColumnMetadata[] | undefined> {
    return getCachedColumnsFromMetadataCacheAsync(
      this.metadataCache,
      connectionName,
      dbName,
      schemaName,
      tableName,
      databaseKind,
    );
  }

  private extractColumnName(column: ColumnMetadata): string {
    return column.label || column.ATTNAME;
  }

  private extractColumnType(column: ColumnMetadata): string | undefined {
    const detail = column.detail || column.FORMAT_TYPE;
    return detail && detail.trim().length > 0 ? detail : undefined;
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
}
