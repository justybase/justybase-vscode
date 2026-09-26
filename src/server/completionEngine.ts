import {
  CompletionItem,
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { CompletionPathResolver } from "./completionPathResolver";
import { CompletionQualifierResolver } from "./completionQualifierResolver";
import { CompletionRequestContextBuilder } from "./completionRequestContext";
import { resolveExpressionClauseContext } from "./completionExpressionAnalyzer";
import { toKeywordItems } from "./completionRenderer";
import { handleMacroVariableCompletion } from "./completionMacroVariableResolver";
import { CompletionScopeResolver } from "./completionScopeResolver";
import type { CompletionMetadataProvider } from "./completionTypes";
import { CompletionWildcardResolver } from "./completionWildcardResolver";

export type { CompletionMetadataProvider } from "./completionTypes";

/**
 * Coordinates SQL completion using focused modules for context extraction,
 * scope analysis, metadata lookup, wildcard propagation, and rendering.
 */
export class LspCompletionEngine {
  private readonly contextExtractor: CompletionContextExtractor;
  private readonly wildcardResolver: CompletionWildcardResolver;
  private readonly metadataResolver: CompletionMetadataResolver;
  private readonly scopeResolver: CompletionScopeResolver;
  private readonly pathResolver: CompletionPathResolver;
  private readonly qualifierResolver: CompletionQualifierResolver;
  private readonly requestContextBuilder: CompletionRequestContextBuilder;

  constructor(
    metadataProvider: CompletionMetadataProvider,
    parseSession?: DocumentParseSession,
  ) {
    this.contextExtractor = new CompletionContextExtractor(parseSession);
    this.wildcardResolver = new CompletionWildcardResolver(parseSession);
    this.metadataResolver = new CompletionMetadataResolver(
      metadataProvider,
      this.wildcardResolver,
      parseSession,
    );
    this.scopeResolver = new CompletionScopeResolver(
      this.contextExtractor,
      this.metadataResolver,
      parseSession,
    );
    this.pathResolver = new CompletionPathResolver(
      this.contextExtractor,
      this.metadataResolver,
    );
    this.qualifierResolver = new CompletionQualifierResolver(
      this.contextExtractor,
      this.scopeResolver,
      this.pathResolver,
    );
    this.requestContextBuilder = new CompletionRequestContextBuilder(
      metadataProvider,
      this.contextExtractor,
    );
  }

  public async provideCompletionItems(
    document: TextDocument,
    position: Position,
    triggerKind: CompletionTriggerKind = CompletionTriggerKind.Invoked,
  ): Promise<CompletionItem[]> {
    let autoJoinConditionTrigger = false;
    if (triggerKind === CompletionTriggerKind.TriggerCharacter) {
      const cursorOffset = document.offsetAt(position);
      const previousChar =
        cursorOffset > 0 ? document.getText().charAt(cursorOffset - 1) : "";
      if (/\s/.test(previousChar)) {
        if (previousChar !== " ") {
          return [];
        }
        const textBeforeSpace = document.getText().substring(
          Math.max(0, cursorOffset - 17),
          Math.max(0, cursorOffset - 1),
        );
        const lastWord = (
          textBeforeSpace.match(/[A-Za-z_][A-Za-z0-9_$]*\s*$/)?.[0] ?? ""
        ).trim().toUpperCase();
        if (lastWord !== "JOIN" && lastWord !== "ON") {
          return [];
        }
        autoJoinConditionTrigger = true;
      }
    }

    const requestContext = await this.requestContextBuilder.build(
      document,
      position,
    );
    if (autoJoinConditionTrigger) {
      const joinTargetItems = await this.scopeResolver.getJoinTargetCompletions(
        requestContext,
      );
      if (joinTargetItems !== undefined) {
        return finalizeCompletionItems(joinTargetItems, triggerKind);
      }
      return finalizeCompletionItems(
        await this.scopeResolver.getJoinConditionCompletions(requestContext),
        triggerKind,
      );
    }

    const macroVariableItems = handleMacroVariableCompletion({
      documentText: requestContext.documentText,
      cursorOffset: requestContext.cursorOffset,
      linePrefix: requestContext.linePrefix,
      position: requestContext.position,
      triggerKind,
    });
    if (macroVariableItems !== undefined) {
      return finalizeCompletionItems(macroVariableItems, triggerKind);
    }

    const pathItems = await this.pathResolver.resolveRequestPathCompletions(
      requestContext,
    );
    if (pathItems !== undefined) {
      return finalizeCompletionItems(pathItems, triggerKind);
    }

    // Right after a completed FROM/JOIN target (with or without alias) a
    // qualifier path like A.| or A.*| is a syntax error; columns can only be
    // referenced through the qualifier inside expression clauses
    // (SELECT list, WHERE, ON, GROUP BY, ORDER BY, HAVING, SET, ...).
    const isFromClauseContinuation =
      resolveExpressionClauseContext(requestContext.statementPrefix) ===
      "from";
    if (!isFromClauseContinuation) {
      const wildcardItems =
        await this.qualifierResolver.resolveWildcardExpansionCompletions(
          requestContext,
        );
      if (wildcardItems !== undefined) {
        return finalizeCompletionItems(wildcardItems, triggerKind);
      }

      const qualifierItems =
        await this.qualifierResolver.resolveQualifierCompletions(requestContext);
      if (qualifierItems !== undefined) {
        return finalizeCompletionItems(qualifierItems, triggerKind);
      }
    }

    const {
      linePrefix,
      position: requestPosition,
      statement,
      statementOffset,
      statementPrefix,
      localDefs,
      documentUri,
      documentVersion,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      completionKeywords,
      sqlFunctionNames,
      sqlFunctionSignatures,
      specialBuiltinValues,
      variables,
    } = requestContext;

    const variableResult = this.scopeResolver.handleVariableCompletion(
      linePrefix,
      variables,
      triggerKind,
    );
    if (variableResult) {
      return finalizeCompletionItems(variableResult, triggerKind);
    }

    const semanticScopeResult = await this.scopeResolver.getSemanticScopeCompletions(
      {
        statement,
        statementOffset,
        statementPrefix,
        linePrefix,
        position: requestPosition,
        triggerKind,
        localDefs,
        documentUri,
        documentVersion,
        effectiveDb,
        effectiveSchema,
        netezzaSchemasEnabled: requestContext.netezzaSchemasEnabled,
        databaseKind,
        completionKeywords,
        sqlFunctionNames,
        sqlFunctionSignatures,
        specialBuiltinValues,
      },
    );
    if (semanticScopeResult !== undefined) {
      return finalizeCompletionItems(semanticScopeResult, triggerKind);
    }

    return finalizeCompletionItems(
      toKeywordItems(
        this.contextExtractor.extractCurrentIdentifierPrefix(linePrefix),
        requestPosition,
        completionKeywords,
      ),
      triggerKind,
    );
  }
}

/**
 * Automatic suggestions must never be accepted by whitespace. This also
 * protects against a stale completion response arriving after the typed
 * prefix stopped matching the previous item (for example `F` -> `FX`).
 */
function finalizeCompletionItems(
  items: CompletionItem[],
  triggerKind: CompletionTriggerKind,
): CompletionItem[] {
  if (triggerKind !== CompletionTriggerKind.TriggerCharacter) {
    return items;
  }

  return items.map((item) => ({
    ...item,
    commitCharacters: (item.commitCharacters ?? []).filter(
      (character) => !/\s/.test(character),
    ),
  }));
}
