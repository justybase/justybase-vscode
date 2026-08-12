import { CompletionItem, Position, Range } from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { LocalDefinition } from "../providers/types";
import { parseAlterTableContext } from "./completionAlterTableContext";
import { CompletionAlterTableResolver } from "./completionAlterTableResolver";
import { normalizeDialectQuotedIdentifiers } from "./completionDialectAdapter";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import {
  toKeywordItems,
  toLocalDefinitionItems,
  toTableTargetLocalItems,
} from "./completionRenderer";
import { parseCallArgumentContext } from "./catalogNavigation";
import type {
  CompletionRequestContext,
  FromJoinContext,
  TableTargetPathContext,
} from "./completionTypes";

/**
 * Resolves path-oriented completion branches such as FROM/JOIN targets and
 * object-name targets in DDL/DML statements.
 */
export class CompletionPathResolver {
  private readonly alterTableResolver: CompletionAlterTableResolver;

  constructor(
    private readonly contextExtractor: CompletionContextExtractor,
    private readonly metadataResolver: CompletionMetadataResolver,
  ) {
    this.alterTableResolver = new CompletionAlterTableResolver(metadataResolver);
  }

  public async resolveRequestPathCompletions(
    requestContext: CompletionRequestContext,
  ): Promise<CompletionItem[] | undefined> {
    const {
      statementPrefix,
      linePrefix,
      prevLine,
      databaseKind,
      localDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      position,
    } = requestContext;

    const alterTableContext = parseAlterTableContext(
      statementPrefix,
      statementPrefix.length,
      databaseKind,
    );
    if (alterTableContext?.kind === "table_target") {
      return this.metadataResolver.resolveTablePathCompletions(
        alterTableContext.path,
        toTableTargetLocalItems(localDefs),
        documentUri,
        effectiveDb,
        databaseKind,
        false,
        effectiveSchema,
      );
    }
    if (alterTableContext?.kind === "action") {
      return this.alterTableResolver.resolve(
        alterTableContext,
        documentUri,
        position,
        effectiveDb,
        effectiveSchema,
        databaseKind,
      );
    }

    const fromJoinContext = this.contextExtractor.parseFromJoinContext(
      statementPrefix,
      linePrefix,
      prevLine,
      databaseKind,
    );
    if (fromJoinContext) {
      const items = await this.metadataResolver.resolveTablePathCompletions(
        fromJoinContext,
        toLocalDefinitionItems(localDefs),
        documentUri,
        effectiveDb,
        databaseKind,
        true,
        effectiveSchema,
      );
      return this.applyFilePathCompletionEdit(items, fromJoinContext, requestContext);
    }

    const callArgContext = parseCallArgumentContext(
      statementPrefix,
      databaseKind,
    );
    if (callArgContext) {
      return this.metadataResolver.resolveCallArgumentCompletions(
        documentUri,
        callArgContext,
        effectiveDb,
        databaseKind,
      );
    }

    if (this.isUpdateSetContext(linePrefix)) {
      return toKeywordItems("", position, ["SET"]);
    }

    if (this.isBareGroomContext(linePrefix)) {
      return toKeywordItems("", position, ["TABLE", "VIEWS"]);
    }

    const insertColumnContext =
      this.contextExtractor.parseInsertColumnListContext(
        statementPrefix,
        databaseKind,
      );
    if (insertColumnContext) {
      const columns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        {
          db: insertColumnContext.database ?? effectiveDb,
          schema: insertColumnContext.schema,
          table: insertColumnContext.table,
        },
        effectiveDb,
        requestContext.effectiveSchema,
        databaseKind,
      );
      const { toColumnItems } = await import("./completionRenderer");
      return toColumnItems(columns.map((col) => col.name));
    }

    const objectTargetContext =
      this.contextExtractor.parseUpdateDropTruncateContext(
        statementPrefix,
        databaseKind,
      );
    if (!objectTargetContext) {
      return undefined;
    }

    return this.resolveObjectTargetPathCompletions(
      objectTargetContext,
      documentUri,
      localDefs,
      effectiveDb,
      effectiveSchema,
      databaseKind,
    );
  }

  public async resolveDotPathFallbackCompletions(
    requestContext: CompletionRequestContext,
  ): Promise<CompletionItem[]> {
    const {
      statementPrefix,
      linePrefix,
      prevLine,
      databaseKind,
      localDefs,
      documentUri,
      effectiveDb,
    } = requestContext;

    const normalizedLinePrefix = normalizeDialectQuotedIdentifiers(
      linePrefix,
      databaseKind,
    );
    const normalizedPrevLine = normalizeDialectQuotedIdentifiers(
      prevLine,
      databaseKind,
    );

    const fromJoinContext =
      this.contextExtractor.parseFromJoinContextFromLineFallback(
        normalizedLinePrefix,
        normalizedPrevLine,
        databaseKind,
      );
    if (fromJoinContext) {
      const items = await this.metadataResolver.resolveTablePathCompletions(
        fromJoinContext,
        toLocalDefinitionItems(localDefs),
        documentUri,
        effectiveDb,
        databaseKind,
        true,
        requestContext.effectiveSchema,
      );
      return this.applyFilePathCompletionEdit(items, fromJoinContext, requestContext);
    }

    const objectTargetContext =
      this.contextExtractor.parseUpdateDropTruncateContext(
        statementPrefix,
        databaseKind,
      );
    if (!objectTargetContext) {
      return [];
    }

    return this.resolveObjectTargetPathCompletions(
      objectTargetContext,
      documentUri,
      localDefs,
      effectiveDb,
      requestContext.effectiveSchema,
      databaseKind,
    );
  }

  private applyFilePathCompletionEdit(
    items: CompletionItem[],
    context: FromJoinContext,
    requestContext: CompletionRequestContext,
  ): CompletionItem[] {
    if (
      context.kind !== "from_join_name"
      || !context.isFilePath
      || !context.isQuoted
      || context.partial.length === 0
    ) {
      return items;
    }

    const startCharacter = Math.max(
      0,
      requestContext.position.character - context.partial.length - 1,
    );
    const nextCharacter = requestContext.documentText[requestContext.cursorOffset] ?? "";
    const endCharacter = requestContext.position.character + (nextCharacter === '"' ? 1 : 0);

    return items.map((item) => ({
      ...item,
      textEdit: {
        range: Range.create(
          Position.create(requestContext.position.line, startCharacter),
          Position.create(requestContext.position.line, endCharacter),
        ),
        newText: typeof item.insertText === "string" ? item.insertText : `"${item.label}"`,
      },
    }));
  }

  private isUpdateSetContext(linePrefix: string): boolean {
    const trimmed = linePrefix.trimEnd();
    if (/\.$/.test(trimmed)) {
      return false;
    }
    return /^UPDATE\s+[^\s,]+(?:\s+AS\s+[^\s.,]+)?$/i.test(trimmed);
  }

  private isBareGroomContext(linePrefix: string): boolean {
    return /^GROOM\s*$/i.test(linePrefix);
  }

  private resolveObjectTargetPathCompletions(
    targetContext: TableTargetPathContext,
    documentUri: string,
    localDefs: LocalDefinition[],
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (targetContext.targetType === "procedure") {
      return this.metadataResolver.resolveProcedurePathCompletions(
        targetContext.path,
        documentUri,
        effectiveDb,
        databaseKind,
        effectiveSchema,
      );
    }

    if (targetContext.targetType === "view") {
      return this.metadataResolver.resolveViewPathCompletions(
        targetContext.path,
        documentUri,
        effectiveDb,
        databaseKind,
        effectiveSchema,
      );
    }

    return this.metadataResolver.resolveTablePathCompletions(
      targetContext.path,
      toTableTargetLocalItems(localDefs),
      documentUri,
      effectiveDb,
      databaseKind,
      false,
      effectiveSchema,
    );
  }
}
