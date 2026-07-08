import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
  Range,
} from "vscode-languageserver/node";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionPathResolver } from "./completionPathResolver";
import {
  filterColumnCompletionItems,
  getCompletionInsertValue,
} from "./completionRenderer";
import { CompletionScopeResolver } from "./completionScopeResolver";
import type { CompletionRequestContext } from "./completionTypes";

/**
 * Resolves qualifier-driven completion branches such as alias members and
 * wildcard column expansion.
 */
export class CompletionQualifierResolver {
  constructor(
    private readonly contextExtractor: CompletionContextExtractor,
    private readonly scopeResolver: CompletionScopeResolver,
    private readonly pathResolver: CompletionPathResolver,
  ) {}

  public async resolveWildcardExpansionCompletions(
    requestContext: CompletionRequestContext,
  ): Promise<CompletionItem[] | undefined> {
    const expandMatch = this.contextExtractor.extractQualifierBeforeDotAndStar(
      requestContext.linePrefix,
    );
    if (!expandMatch) {
      return undefined;
    }

    const columns = await this.scopeResolver.resolveColumnsForQualifier({
      qualifier: expandMatch.qualifier,
      statement: requestContext.statement,
      statementOffset: requestContext.statementOffset,
      documentText: requestContext.documentText,
      cursorOffset: requestContext.cursorOffset,
      localDefs: requestContext.localDefs,
      resolutionLocalDefs: requestContext.resolutionLocalDefs,
      documentUri: requestContext.documentUri,
      documentVersion: requestContext.documentVersion,
      effectiveDb: requestContext.effectiveDb,
      effectiveSchema: requestContext.effectiveSchema,
      netezzaSchemasEnabled: requestContext.netezzaSchemasEnabled,
      databaseKind: requestContext.databaseKind,
    });
    if (columns.length === 0) {
      return undefined;
    }

    const insertTokens = columns
      .map((item) => getCompletionInsertValue(item))
      .filter((value): value is string => !!value);
    if (insertTokens.length === 0) {
      return undefined;
    }

    const startCharacter = Math.max(
      0,
      requestContext.position.character - expandMatch.fullMatch.length,
    );
    const expandedInsert = insertTokens
      .map((token) => `${expandMatch.qualifier}.${token}`)
      .join(", ");

    return [
      {
        label: "* (Expand Columns)",
        kind: CompletionItemKind.Snippet,
        detail: "Expand columns",
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit: {
          range: Range.create(
            Position.create(requestContext.position.line, startCharacter),
            requestContext.position,
          ),
          newText: expandedInsert,
        },
      },
    ];
  }

  public async resolveQualifierCompletions(
    requestContext: CompletionRequestContext,
  ): Promise<CompletionItem[] | undefined> {
    const qualifierContext = this.contextExtractor.extractQualifierColumnContext(
      requestContext.linePrefix,
    );
    if (!qualifierContext) {
      return undefined;
    }
    const { qualifier, columnPrefix } = qualifierContext;

    const columns = await this.scopeResolver.resolveColumnsForQualifier({
      qualifier,
      statement: requestContext.statement,
      statementOffset: requestContext.statementOffset,
      documentText: requestContext.documentText,
      cursorOffset: requestContext.cursorOffset,
      localDefs: requestContext.localDefs,
      resolutionLocalDefs: requestContext.resolutionLocalDefs,
      documentUri: requestContext.documentUri,
      documentVersion: requestContext.documentVersion,
      effectiveDb: requestContext.effectiveDb,
      effectiveSchema: requestContext.effectiveSchema,
      netezzaSchemasEnabled: requestContext.netezzaSchemasEnabled,
      databaseKind: requestContext.databaseKind,
    });
    const filteredColumns = filterColumnCompletionItems(
      columns,
      columnPrefix,
      requestContext.position,
    );
    if (filteredColumns.length > 0) {
      if (!columnPrefix) {
        const insertTokens = filteredColumns
          .map((item) => getCompletionInsertValue(item))
          .filter((value): value is string => !!value);
        if (insertTokens.length > 0) {
          const expandedInsert =
            insertTokens[0] +
            (insertTokens.length > 1
              ? ", " +
                insertTokens
                  .slice(1)
                  .map((token) => `${qualifier}.${token}`)
                  .join(", ")
              : "");
          const expandItem: CompletionItem = {
            label: "* (Expand Columns)",
            kind: CompletionItemKind.Snippet,
            detail: "Expand columns",
            insertText: expandedInsert,
            insertTextFormat: InsertTextFormat.PlainText,
            sortText: "0000_expand",
          };
          return [expandItem, ...filteredColumns];
        }
      }
      return filteredColumns;
    }

    const contextualPathItems =
      await this.pathResolver.resolveDotPathFallbackCompletions(requestContext);
    if (contextualPathItems.length > 0) {
      return contextualPathItems;
    }

    return [];
  }
}