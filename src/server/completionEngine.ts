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
    const requestContext = await this.requestContextBuilder.build(
      document,
      position,
    );
    const macroVariableItems = handleMacroVariableCompletion({
      documentText: requestContext.documentText,
      cursorOffset: requestContext.cursorOffset,
      linePrefix: requestContext.linePrefix,
      position: requestContext.position,
    });
    if (macroVariableItems !== undefined) {
      return macroVariableItems;
    }

    const pathItems = await this.pathResolver.resolveRequestPathCompletions(
      requestContext,
    );
    if (pathItems !== undefined) {
      return pathItems;
    }

    const wildcardItems =
      await this.qualifierResolver.resolveWildcardExpansionCompletions(
        requestContext,
      );
    if (wildcardItems !== undefined) {
      return wildcardItems;
    }

    const qualifierItems =
      await this.qualifierResolver.resolveQualifierCompletions(requestContext);
    if (qualifierItems !== undefined) {
      return qualifierItems;
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
      specialBuiltinValues,
      variables,
    } = requestContext;

    const variableResult = this.scopeResolver.handleVariableCompletion(
      linePrefix,
      variables,
      triggerKind,
    );
    if (variableResult) {
      return variableResult;
    }

    const semanticScopeResult = await this.scopeResolver.getSemanticScopeCompletions(
      {
        statement,
        statementOffset,
        statementPrefix,
        linePrefix,
        position: requestPosition,
        localDefs,
        documentUri,
        documentVersion,
        effectiveDb,
        effectiveSchema,
        netezzaSchemasEnabled: requestContext.netezzaSchemasEnabled,
        databaseKind,
        completionKeywords,
        sqlFunctionNames,
        specialBuiltinValues,
      },
    );
    if (semanticScopeResult && semanticScopeResult.length > 0) {
      return semanticScopeResult;
    }

    return toKeywordItems(
      this.contextExtractor.extractCurrentIdentifierPrefix(linePrefix),
      requestPosition,
      completionKeywords,
    );
  }
}
