import { CompletionItem, Position } from "vscode-languageserver/node";
import {
  getAlterTableKeywordsForPhase,
  normalizeAlterTableTypedPrefix,
} from "../dialects/netezza/sql/alterTableCompletion";
import type { DatabaseKind } from "../contracts/database";
import type { AlterTableCompletionContext } from "./completionAlterTableContext";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { toKeywordItems, toMetadataColumnItem } from "./completionRenderer";
import type { QualifiedTableName } from "./completionTypes";

/**
 * Resolves ALTER TABLE completion items for Netezza DDL phases.
 */
export class CompletionAlterTableResolver {
  constructor(private readonly metadataResolver: CompletionMetadataResolver) {}

  public async resolve(
    context: AlterTableCompletionContext & { kind: "action" },
    documentUri: string,
    position: Position,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    const { phase, table } = context;
    const typedPrefix = normalizeAlterTableTypedPrefix(
      phase,
      context.typedPrefix,
      table.table,
    );
    const columnPhases = new Set([
      "drop_column",
      "alter_column",
      "rename_column",
      "modify_column",
      "organize_on",
    ]);

    if (columnPhases.has(phase)) {
      const columns = await this.getTableColumns(
        documentUri,
        table,
        effectiveDb,
        effectiveSchema,
        databaseKind,
      );
      if (phase === "organize_on") {
        const columnItems = columns.map((column) => toMetadataColumnItem(column));
        return [
          ...toKeywordItems(typedPrefix, position, ["NONE"]),
          ...columnItems.filter((item) =>
            !typedPrefix ||
            item.label.toUpperCase().startsWith(typedPrefix.toUpperCase()),
          ),
        ];
      }
      return columns
        .map((column) => toMetadataColumnItem(column))
        .filter(
          (item) =>
            !typedPrefix ||
            item.label.toUpperCase().startsWith(typedPrefix.toUpperCase()),
        );
    }

    const keywords = getAlterTableKeywordsForPhase(phase);
    return toKeywordItems(typedPrefix, position, keywords);
  }

  private getTableColumns(
    documentUri: string,
    table: QualifiedTableName,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
  ) {
    return this.metadataResolver.getMetadataColumnsForSource(
      documentUri,
      {
        db: table.database ?? effectiveDb,
        schema: table.schema ?? effectiveSchema,
        table: table.table,
      },
      effectiveDb,
      effectiveSchema,
      databaseKind,
    );
  }
}
