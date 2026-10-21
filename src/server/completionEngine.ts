import { buildSqlSourceScanIndex } from "@justybase/sql-core/sourceScan";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import type { CompletionKeywordCase } from "../lsp/protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { CompletionPathResolver } from "./completionPathResolver";
import { CompletionQualifierResolver } from "./completionQualifierResolver";
import { CompletionRequestContextBuilder } from "./completionRequestContext";
import {
  STATEMENT_START_KEYWORDS,
  isBareStatementStart,
  resolveExpressionClauseContext,
} from "./completionExpressionAnalyzer";
import { toKeywordItems } from "./completionRenderer";
import { handleMacroVariableCompletion } from "./completionMacroVariableResolver";
import { CompletionScopeResolver } from "./completionScopeResolver";
import { buildSnippetCompletionItems } from "./completionSnippetResolver";
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
    const requestState: CompletionRequestState = {};
    const items = applyKeywordCase(
      await this.provideBaseCompletionItems(document, position, triggerKind, requestState),
      requestState.keywordCase,
      this.contextExtractor.extractCurrentIdentifierPrefix(
        this.contextExtractor.getLinePrefix(document, position),
      ),
    );
    const prefixText = document.getText().slice(0, document.offsetAt(position));
    const isInvoked = triggerKind === CompletionTriggerKind.Invoked;
    const endsWithJoin = /JOIN\s+$/i.test(prefixText);
    if (!isInvoked || !endsWithJoin) {
      return items;
    }
    // An explicit invoke right after JOIN offers the same relationship-aware
    // targets as the automatic trigger, ahead of the ordinary relation list.
    const joinTargets = await this.scopeResolver.getJoinTargetCompletions(
      await this.requestContextBuilder.build(document, position),
    );
    if (!joinTargets?.length) {
      return items;
    }
    const seen = new Set(joinTargets.map((item) => item.label));
    return [
      ...joinTargets,
      ...items
        .filter((item) => !seen.has(item.label))
        .map((item) => ({ ...item, sortText: `1_${item.sortText ?? item.label}` })),
    ];
  }

  private async provideBaseCompletionItems(
    document: TextDocument,
    position: Position,
    triggerKind: CompletionTriggerKind,
    requestState: CompletionRequestState,
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
    requestState.keywordCase = requestContext.completionKeywordCase;
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

    const text = document.getText();
    const offset = document.offsetAt(position);
    const scan = buildSqlSourceScanIndex(text, requestContext.databaseKind);
    const insideLiteralOrComment = offset > 0 && (scan.isInSingleQuotedString(offset - 1) || scan.isInComment(offset - 1));
    if (requestContext.databaseKind === 'postgresql' && insideLiteralOrComment) return [];

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
    if (insideLiteralOrComment) return [];

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
        joinCompletionSettings: requestContext.joinCompletionSettings,
        databaseKind,
        completionKeywords,
        sqlFunctionNames,
        sqlFunctionSignatures,
        specialBuiltinValues,
      },
    );
    const typedPrefix = this.contextExtractor.extractCurrentIdentifierPrefix(linePrefix);
    const snippetItems = buildSnippetCompletionItems(
      databaseKind,
      statementPrefix,
      typedPrefix,
      requestPosition,
    );
    if (semanticScopeResult !== undefined) {
      return finalizeCompletionItems([...semanticScopeResult, ...snippetItems], triggerKind);
    }

    // At the very start of a statement only statement-opening keywords fit
    // (`SE|` -> SELECT, SET, ... but not OFFSET, INTERSECT or CASE).
    const keywordItems = toKeywordItems(typedPrefix, requestPosition, completionKeywords);
    const startKeywordItems = isBareStatementStart(statementPrefix, typedPrefix)
      ? keywordItems.filter((item) => STATEMENT_START_KEYWORDS.has(item.label.toUpperCase()))
      : [];
    return finalizeCompletionItems(
      [
        ...(startKeywordItems.length > 0 ? startKeywordItems : keywordItems),
        ...snippetItems,
      ],
      triggerKind,
    );
  }
}

interface CompletionRequestState {
  keywordCase?: CompletionKeywordCase;
}

/**
 * Inserts keywords in the configured case (`justybase.sql.completionKeywordCase`);
 * labels stay upper-case so the list looks the same. `matchTyped` follows an
 * all-lower-case typed prefix (`sel` -> `select`).
 */
function applyKeywordCase(
  items: CompletionItem[],
  keywordCase: CompletionKeywordCase | undefined,
  typedPrefix: string,
): CompletionItem[] {
  const lower =
    keywordCase === "lower" ||
    (keywordCase === "matchTyped" && /[a-z]/.test(typedPrefix) && typedPrefix === typedPrefix.toLowerCase());
  if (!lower) {
    return items;
  }
  return items.map((item) => {
    if (item.kind !== CompletionItemKind.Keyword) {
      return item;
    }
    const text = (item.textEdit?.newText ?? item.insertText ?? item.label).toLowerCase();
    return item.textEdit
      ? { ...item, textEdit: { ...item.textEdit, newText: text } }
      : { ...item, insertText: text };
  });
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
