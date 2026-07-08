import type { CompletionItem } from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { LocalDefinition } from "../providers/types";
import { parseAlterTableContext } from "./completionAlterTableContext";
import { CompletionAlterTableResolver } from "./completionAlterTableResolver";
import { normalizeDialectQuotedIdentifiers } from "./completionDialectAdapter";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import {
  toLocalDefinitionItems,
  toTableTargetLocalItems,
} from "./completionRenderer";
import { parseCallArgumentContext } from "./catalogNavigation";
import type {
  CompletionRequestContext,
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
      return this.metadataResolver.resolveTablePathCompletions(
        fromJoinContext,
        toLocalDefinitionItems(localDefs),
        documentUri,
        effectiveDb,
        databaseKind,
        true,
      );
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
      return this.metadataResolver.resolveTablePathCompletions(
        fromJoinContext,
        toLocalDefinitionItems(localDefs),
        documentUri,
        effectiveDb,
        databaseKind,
        true,
      );
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
      databaseKind,
    );
  }

  private resolveObjectTargetPathCompletions(
    targetContext: TableTargetPathContext,
    documentUri: string,
    localDefs: LocalDefinition[],
    effectiveDb: string | undefined,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (targetContext.targetType === "procedure") {
      return this.metadataResolver.resolveProcedurePathCompletions(
        targetContext.path,
        documentUri,
        effectiveDb,
        databaseKind,
      );
    }

    if (targetContext.targetType === "view") {
      return this.metadataResolver.resolveViewPathCompletions(
        targetContext.path,
        documentUri,
        effectiveDb,
        databaseKind,
      );
    }

    return this.metadataResolver.resolveTablePathCompletions(
      targetContext.path,
      toTableTargetLocalItems(localDefs),
      documentUri,
      effectiveDb,
      databaseKind,
    );
  }
}