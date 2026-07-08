import type { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import type { DatabaseKind } from "../contracts/database";
import { normalizeDialectQuotedIdentifiers } from "./completionDialectAdapter";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { mergeLocalDefinitions } from "./completionLocalDefinitionUtils";
import type {
  CompletionMetadataProvider,
  CompletionRequestContext,
} from "./completionTypes";

/**
 * Builds normalized request state shared across completion branches.
 */
export class CompletionRequestContextBuilder {
  private readonly sqlFunctionNamesCache = new Map<string, readonly string[]>();
  private readonly specialBuiltinValuesCache = new Map<string, readonly string[]>();

  constructor(
    private readonly metadataProvider: CompletionMetadataProvider,
    private readonly contextExtractor: CompletionContextExtractor,
  ) {}

  public async build(
    document: TextDocument,
    position: Position,
  ): Promise<CompletionRequestContext> {
    const context = await this.metadataProvider.getContext(document.uri);
    const databaseKind = context.databaseKind;
    const effectiveDb = context.effectiveDatabase;
    const effectiveSchema = context.effectiveSchema;
    const netezzaSchemasEnabled = context.netezzaSchemasEnabled;

    const linePrefix = normalizeDialectQuotedIdentifiers(
      this.contextExtractor.getLinePrefix(document, position),
      databaseKind,
    );
    const prevLine = normalizeDialectQuotedIdentifiers(
      this.contextExtractor.getLineText(document, position.line - 1),
      databaseKind,
    );
    const cursorOffset = document.offsetAt(position);
    const parsed = this.contextExtractor.getParsedContext(
      document,
      databaseKind,
      cursorOffset,
    );
    const documentText = document.getText();
    const statement = this.contextExtractor.getStatementAtPosition(
      documentText,
      cursorOffset,
      document.uri,
      document.version,
    );
    const statementOffset = statement
      ? cursorOffset - statement.start
      : cursorOffset;
    const statementPrefix = statement
      ? statement.sql.substring(0, statementOffset)
      : documentText.substring(0, cursorOffset);
    const statementSqlForContext = statement ? statement.sql : documentText;
    const localDefs = this.contextExtractor.getVisibleLocalDefinitionsForFromJoin(
      parsed.localDefs,
      statementSqlForContext,
      statementOffset,
      databaseKind,
      document.uri,
      document.version,
    );
    const resolutionLocalDefs = mergeLocalDefinitions(
      parsed.allLocalDefs,
      localDefs,
    );
    const authoring = getDatabaseSqlAuthoring(databaseKind);

    return {
      documentUri: document.uri,
      documentVersion: document.version,
      position,
      databaseKind,
      effectiveDb,
      effectiveSchema,
      netezzaSchemasEnabled,
      linePrefix,
      prevLine,
      cursorOffset,
      documentText,
      statement,
      statementOffset,
      statementPrefix,
      localDefs,
      resolutionLocalDefs,
      variables: parsed.variables,
      completionKeywords: authoring.completionKeywords,
      sqlFunctionNames: this.getSqlFunctionNames(databaseKind),
      specialBuiltinValues: this.getSpecialBuiltinValues(databaseKind),
    };
  }

  private getSqlFunctionNames(databaseKind?: DatabaseKind): readonly string[] {
    const cacheKey = databaseKind ?? "default";
    const cached = this.sqlFunctionNamesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sortedNames = Array.from(
      getDatabaseSqlAuthoring(databaseKind).validation.builtinFunctions,
    ).sort();
    this.sqlFunctionNamesCache.set(cacheKey, sortedNames);
    return sortedNames;
  }

  private getSpecialBuiltinValues(databaseKind?: DatabaseKind): readonly string[] {
    const cacheKey = databaseKind ?? "default";
    const cached = this.specialBuiltinValuesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sortedValues = Array.from(
      getDatabaseSqlAuthoring(databaseKind).validation.specialBuiltinValues,
    ).sort();
    this.specialBuiltinValuesCache.set(cacheKey, sortedValues);
    return sortedValues;
  }
}