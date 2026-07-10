import {
  CompletionItem,
  CompletionItemKind,
  Position,
  Range,
} from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import type { LocalDefinition } from "../providers/types";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { isCompletableLocalDefinition } from "./completionLocalDefinitionUtils";
import { matchesPrefix } from "./completionRanker";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import type { ScopedColumnCandidate } from "./completionTypes";
import { attachCompletionDescription } from "./completionDescriptionUtils";
import {
  buildFunctionCompletionDetail,
  buildFunctionInlineDescription,
  buildFunctionSignatureDocumentation,
} from "./functionCompletionUtils";

/**
 * Completion item rendering helpers that keep construction consistent.
 */
export function toTableTargetLocalItems(
  localDefs: LocalDefinition[],
): CompletionItem[] {
  const targetDefs = localDefs.filter((def) => {
    const type = def.type.toUpperCase();
    return type === "TABLE" || type === "TEMP TABLE";
  });
  return toLocalDefinitionItems(targetDefs);
}

export function toColumnItems(columns: string[]): CompletionItem[] {
  return columns
    .filter((column) => {
      const normalized = column.trim();
      return !!normalized && normalized !== "*" && !normalized.endsWith(".*");
    })
    .map((column) => ({
      label: column,
      kind: CompletionItemKind.Field,
      detail: "Local column",
      sortText: `2_${column}`,
    }));
}

export function toLocalDefinitionItems(
  localDefs: LocalDefinition[],
): CompletionItem[] {
  return localDefs
    .filter((definition) => isCompletableLocalDefinition(definition))
    .map((definition) => ({
      label: definition.name,
      kind: CompletionItemKind.Class,
      detail: definition.type,
      sortText: `1_${definition.name}`,
    }));
}

export function toMetadataColumnItem(
  column: MetadataColumnItem,
): CompletionItem {
  return attachCompletionDescription(
    {
      label: column.name,
      kind: CompletionItemKind.Field,
      detail: column.type,
      sortText: `3_${column.name}`,
    },
    column.description,
  );
}

export function toKeywordItems(
  prefix: string,
  position: Position,
  completionKeywords: readonly string[],
): CompletionItem[] {
  const prefixUpper = prefix.toUpperCase();
  return completionKeywords
    .filter((keyword) => !prefix || keyword.startsWith(prefixUpper))
    .map((keyword) => {
      const item: CompletionItem = {
        label: keyword,
        kind: CompletionItemKind.Keyword,
        detail: "SQL Keyword",
        sortText: `5_${keyword}`,
      };
      applyPrefixRange(item, position, prefix);
      return item;
    });
}

export function toScopedColumnItems(
  scopedColumns: ScopedColumnCandidate[],
  typedPrefix: string,
  position: Position,
): CompletionItem[] {
  const typedPrefixUpper = typedPrefix.toUpperCase();
  const items: CompletionItem[] = [];

  for (const scoped of scopedColumns) {
    const columnUpper = scoped.column.toUpperCase();
    const singleSource = scoped.qualifiers.length <= 1;

    if (singleSource) {
      if (typedPrefix && !columnUpper.startsWith(typedPrefixUpper)) {
        continue;
      }
      const item = attachCompletionDescription(
        {
          label: scoped.column,
          kind: CompletionItemKind.Field,
          detail: "Column in scope",
          sortText: `2_${scoped.column}`,
        },
        scoped.description,
      );
      applyPrefixRange(item, position, typedPrefix);
      items.push(item);
      continue;
    }

    for (const qualifier of scoped.qualifiers) {
      if (typedPrefix && !columnUpper.startsWith(typedPrefixUpper)) {
        continue;
      }
      const label = `${qualifier}.${scoped.column}`;
      const item = attachCompletionDescription(
        {
          label,
          kind: CompletionItemKind.Field,
          detail: "Qualified column (ambiguous name)",
          insertText: label,
          sortText: `2_${label}`,
        },
        scoped.description,
      );
      applyPrefixRange(item, position, typedPrefix);
      items.push(item);
    }
  }

  return items;
}

export function toFunctionItems(
  typedPrefix: string,
  position: Position,
  sqlFunctionNames: readonly string[],
  sqlFunctionSignatures?: ReadonlyMap<
    string,
    readonly DatabaseSqlFunctionSignature[]
  >,
): CompletionItem[] {
  const typedPrefixUpper = typedPrefix.toUpperCase();
  return sqlFunctionNames
    .filter((name) => !typedPrefix || name.startsWith(typedPrefixUpper))
    .map((name) => {
      const signatures = sqlFunctionSignatures?.get(name);
      const inlineDescription = buildFunctionInlineDescription(signatures);
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Function,
        detail: buildFunctionCompletionDetail(signatures),
        insertText: `${name}()`,
        sortText: `4_${name}`,
        documentation: buildFunctionSignatureDocumentation(signatures),
        labelDetails: inlineDescription
          ? { description: inlineDescription }
          : undefined,
      };
      applyPrefixRange(item, position, typedPrefix);
      return item;
    });
}

export function toSpecialValueItems(
  typedPrefix: string,
  position: Position,
  specialValues: readonly string[],
): CompletionItem[] {
  const typedPrefixUpper = typedPrefix.toUpperCase();
  return specialValues
    .filter((name) => !typedPrefix || name.startsWith(typedPrefixUpper))
    .map((name) => {
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Constant,
        detail: "Session variable",
        sortText: `3_${name}`,
      };
      applyPrefixRange(item, position, typedPrefix);
      return item;
    });
}

export function filterColumnCompletionItems(
  columns: CompletionItem[],
  columnPrefix: string,
  position: Position,
): CompletionItem[] {
  const columnPrefixUpper = columnPrefix.toUpperCase();
  return columns
    .filter((item) => {
      const label = typeof item.label === "string" ? item.label : "";
      return (
        !columnPrefix || label.toUpperCase().startsWith(columnPrefixUpper)
      );
    })
    .map((item) => {
      if (!columnPrefix) {
        return item;
      }
      const filteredItem: CompletionItem = { ...item };
      applyPrefixRange(filteredItem, position, columnPrefix);
      return filteredItem;
    });
}

export function applyPrefixRange(
  item: CompletionItem,
  position: Position,
  typedPrefix: string,
): void {
  if (!typedPrefix) {
    return;
  }
  const startCharacter = Math.max(0, position.character - typedPrefix.length);
  const replacement = getCompletionInsertValue(item) || item.label;
  item.textEdit = {
    range: Range.create(
      Position.create(position.line, startCharacter),
      position,
    ),
    newText: replacement,
  };
}

export function getCompletionInsertValue(
  item: CompletionItem,
): string | undefined {
  if (typeof item.insertText === "string" && item.insertText.trim()) {
    return item.insertText.trim();
  }
  if (typeof item.label === "string" && item.label.trim()) {
    return item.label.replace(/^[^\w"]+\s+/, "").trim();
  }
  return undefined;
}

export function filterMetadataItems(
  items: MetadataObjectItem[],
  prefix: string,
  kindOverride?: CompletionItemKind,
  databaseKind?: DatabaseKind,
): CompletionItem[] {
  return items
    .filter((item) => matchesPrefix(item.name, prefix))
    .map((item) => {
      const insertText = formatIdentifierForSql(item.name, databaseKind);
      return attachCompletionDescription(
        {
          label: item.name,
          kind: kindOverride || toCompletionKind(item.objectType),
          detail: item.detail,
          sortText: `3_${item.name}`,
          insertText,
        },
        item.description,
      );
    });
}

export function toCompletionKind(
  objectType: MetadataObjectItem["objectType"],
): CompletionItemKind {
  if (objectType === "view") {
    return CompletionItemKind.Interface;
  }
  if (objectType === "procedure") {
    return CompletionItemKind.Function;
  }
  return CompletionItemKind.Class;
}