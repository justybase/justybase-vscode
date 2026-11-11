import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
  Range,
} from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import type { LocalDefinition } from "../providers/types";
import { appendEstimatedRowCount } from "../metadata/estimatedRowCount";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { getRelatedColumnRole, isSelfNamedKeyColumn } from "../utils/relatedColumnNames";
import {
  createNetezzaCatalogIdentifier,
  formatNetezzaIdentifier,
} from "../dialects/netezza/metadata/identifierUtils";
import { isCompletableLocalDefinition } from "./completionLocalDefinitionUtils";
import { getCompletionMatchRank, matchesPrefix } from "./completionRanker";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import type { ScopedColumnCandidate } from "./completionTypes";
import { attachCompletionDescription } from "./completionDescriptionUtils";
import {
  buildFunctionCompletionDetail,
  buildFunctionInlineDescription,
  buildFunctionSignatureDocumentation,
} from "./functionCompletionUtils";
import {
  buildObjectSortText,
  columnClausePrior,
  OBJECT_BANDS,
} from "@justybase/sql-core/joinKnowledge";
import { classifySqlDataType } from "@justybase/sql-core/validation/visitor/typeComparisonUtils";
import {
  getObjectPreference,
  getWorkspaceObjectBand,
  isObjectPersonalizationEnabled,
  hasObjectPreferences,
} from "./joinKnowledgeRanking";

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

export function toLocalVariableItems(
  localDefs: LocalDefinition[],
  typedPrefix: string,
  position: Position,
): CompletionItem[] {
  return localDefs
    .filter((definition) => {
      const type = definition.type.toUpperCase();
      return (
        (type === "VARIABLE" || type === "PARAMETER") &&
        matchesPrefix(definition.name, typedPrefix)
      );
    })
    .map((definition) => {
      const item: CompletionItem = {
        label: definition.name,
        kind: CompletionItemKind.Variable,
        detail: `PL/SQL ${definition.type.toLowerCase()}`,
        sortText: `1_${definition.name}`,
      };
      applyPrefixRange(item, position, typedPrefix);
      return item;
    });
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
  return completionKeywords
    .filter((keyword) => matchesPrefix(keyword, prefix))
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

/**
 * Two-digit usage band segment for one column list. Emitted only when at least
 * one column of the list has learned usage, so lists without knowledge keep
 * their previous `sortText` exactly; unused columns then sort as neutral `50`.
 */
function columnBandSegment(band: number | undefined, active: boolean): string {
  if (!active) {
    return "";
  }
  return `${String(band ?? OBJECT_BANDS.neutral).padStart(2, "0")}_`;
}

/** Where a qualified column list is requested, for the catalog prior. */
export interface ColumnPriorContext {
  clause: string | undefined;
  table: string;
}

/** Metadata columns of one table, ordered by learned usage when available. */
export function toRankedMetadataColumnItems(
  columns: readonly MetadataColumnItem[],
  usageBands: ReadonlyMap<string, number> | undefined,
  prior?: ColumnPriorContext,
): CompletionItem[] {
  const active = usageBands !== undefined && usageBands.size > 0;
  return columns.map((column) => {
    const item = toMetadataColumnItem(column);
    const priorSegment = prior ? columnPriorSegment(column, prior) : "";
    if (active) {
      const band = usageBands.get(column.name.replace(/^"|"$/g, "").toUpperCase());
      item.sortText = `3_${columnBandSegment(band, true)}${priorSegment}${column.name}`;
    } else if (priorSegment) {
      item.sortText = `3_${priorSegment}${column.name}`;
    }
    return item;
  });
}

/** PK/FK flags or names, a self-named key (`DIMPRODUCT.PRODUCTKEY`) or an `…ID`/`…KEY`/`…SK` name. */
function isKeyLikeColumn(column: MetadataColumnItem, table: string): boolean {
  return getRelatedColumnRole(column) !== "unknown"
    || isSelfNamedKeyColumn(column.name, table)
    || /(?:ID|KEY|SK)$/u.test(column.name.replace(/"/g, "").toUpperCase());
}

/** `0_`/`1_` catalog prior inside the usage band (`COLUMN_CLAUSE_PRIOR`), or empty. */
function columnPriorSegment(column: MetadataColumnItem, prior: ColumnPriorContext): string {
  const keys = columnClausePrior(prior.clause);
  if (!keys) {
    return "";
  }
  const keyLike = isKeyLikeColumn(column, prior.table);
  const preferred = keys === "measure"
    // Without a known type only keys move last, as in SELECT.
    ? !keyLike && ["numeric", "unknown"].includes(classifySqlDataType(column.type))
    : keyLike === (keys === "first");
  return preferred ? "0_" : "1_";
}

export function toScopedColumnItems(
  scopedColumns: ScopedColumnCandidate[],
  typedPrefix: string,
  position: Position,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const bandsActive = scopedColumns.some((scoped) => scoped.usageBand !== undefined);

  for (const scoped of scopedColumns) {
    const columnUpper = scoped.column.toUpperCase();
    const matchRank = getCompletionMatchRank(scoped.column, typedPrefix) ?? 9;
    // The usage band follows the match rank: learned usage reorders columns
    // only among equally good prefix matches.
    const sortPrefix = `${typedPrefix ? `${matchRank}_` : ""}${columnBandSegment(scoped.usageBand, bandsActive)}`;
    const singleSource = scoped.qualifiers.length <= 1;

    if (singleSource) {
      if (typedPrefix && !matchesPrefix(scoped.column, typedPrefix)) {
        continue;
      }
      const item = attachCompletionDescription(
        {
          label: scoped.column,
          kind: CompletionItemKind.Field,
          detail: "Column in scope",
          sortText: `2_${sortPrefix}${columnUpper}`,
        },
        scoped.description,
      );
      applyPrefixRange(item, position, typedPrefix);
      items.push(item);
      continue;
    }

    for (const qualifier of scoped.qualifiers) {
      if (typedPrefix && !matchesPrefix(scoped.column, typedPrefix)) {
        continue;
      }
      const label = `${qualifier}.${scoped.column}`;
      const item = attachCompletionDescription(
        {
          label,
          kind: CompletionItemKind.Field,
          detail: "Qualified column (ambiguous name)",
          insertText: label,
        sortText: `2_${sortPrefix}${label.toUpperCase()}`,
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
  return sqlFunctionNames
    .filter((name) => matchesPrefix(name, typedPrefix))
    .flatMap((name) => {
      const signatures = sqlFunctionSignatures?.get(name);
      const inlineDescription = buildFunctionInlineDescription(signatures);
      const windowMode = signatures?.find((signature) => signature.window)?.window;
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Function,
        detail: buildFunctionCompletionDetail(signatures),
        insertText: `${name}()`,
        sortText: `4_${getCompletionMatchRank(name, typedPrefix) ?? 9}_${name}`,
        documentation: buildFunctionSignatureDocumentation(signatures),
        labelDetails: inlineDescription
          ? { description: inlineDescription }
          : undefined,
      };
      if (windowMode === "required") {
        item.insertText = buildWindowFunctionSnippet(name, signatures);
        item.insertTextFormat = InsertTextFormat.Snippet;
      }
      applyPrefixRange(item, position, typedPrefix);
      if (windowMode !== "supported") return [item];

      const windowItem: CompletionItem = {
        ...item,
        label: `${name}() OVER (…)`,
        detail: `${item.detail ?? name} (window)`,
        sortText: `4_${getCompletionMatchRank(name, typedPrefix) ?? 9}_${name}_window`,
        insertText: buildWindowFunctionSnippet(name, signatures),
        insertTextFormat: InsertTextFormat.Snippet,
        filterText: name,
      };
      return [item, windowItem];
    });
}

function buildWindowFunctionSnippet(
  name: string,
  signatures: readonly DatabaseSqlFunctionSignature[] | undefined,
): string {
  const parameters = signatures?.[0]?.parameters ?? [];
  const argumentSlots = parameters
    .filter((parameter) => !/^OVER\b/i.test(parameter))
    .map((_parameter, index) => "$" + (index + 1));
  const overSlot = argumentSlots.length + 1;
  const functionCall = argumentSlots.length ? `${name}(${argumentSlots.join(", ")})` : `${name}()`;
  return `${functionCall} OVER ($${overSlot})$0`;
}

export function toSpecialValueItems(
  typedPrefix: string,
  position: Position,
  specialValues: readonly string[],
): CompletionItem[] {
  return specialValues
    .filter((name) => matchesPrefix(name, typedPrefix))
    .map((name) => {
      const item: CompletionItem = {
        label: name,
        kind: CompletionItemKind.Constant,
        detail: "Session variable",
        sortText: `3_${getCompletionMatchRank(name, typedPrefix) ?? 9}_${name}`,
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
  return columns
    .filter((item) => {
      const label = typeof item.label === "string" ? item.label : "";
      return !columnPrefix || matchesPrefix(label, columnPrefix);
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
  options?: {
    sortPrefix?: (item: MetadataObjectItem) => string;
    ranking?: MetadataCompletionRanking;
  },
): CompletionItem[] {
  const preferencesActive = hasObjectPreferences()
    && options?.ranking?.personalizeFromObjects === true;
  return items
    .filter((item) => matchesPrefix(item.name, prefix))
    .flatMap((item) => {
      const preference = options?.ranking?.role === "source"
        && options.ranking.personalizeFromObjects === true
        ? getObjectPreference(
            {
              database: item.database,
              schema: item.schema,
              name: item.name,
            },
            databaseKind,
            {
              database: options.ranking.effectiveDatabase,
              schema: options.ranking.effectiveSchema,
            },
          )
        : undefined;
      if (preference?.kind === "exclude") {
        return [];
      }
      const workspaceBand = options?.ranking?.role === "source"
        && options.ranking.personalizeFromObjects === true
        ? getWorkspaceObjectBand(
            {
              database: item.database,
              schema: item.schema,
              name: item.name,
            },
            databaseKind,
            {
              database: options.ranking.effectiveDatabase,
              schema: options.ranking.effectiveSchema,
            },
          )
        : undefined;
      // Manual exclude > pin > manual boost > learned > manual demote > neutral.
      const learnedBand = preference === undefined ? workspaceBand : undefined;

      const insertText = databaseKind === "netezza"
        ? formatNetezzaIdentifier(createNetezzaCatalogIdentifier(item.name))
        : formatIdentifierForSql(item.name, databaseKind);
      // Netezza system views (_V_*) stay available but sort after user objects.
      const sortPrefix =
        options?.sortPrefix?.(item) ??
        getMetadataSortPrefix(item, databaseKind, options?.ranking) ??
        (databaseKind === "netezza" && item.name.startsWith("_V_")
          ? "9_"
          : "3_");
      const detail = appendEstimatedRowCount(
        options?.ranking?.role === "location" && databaseKind === "db2"
          ? "Db2 location (CURRENT SERVER)"
          : item.detail,
        item.rowCount,
      );
      const completionRank = getCompletionMatchRank(item.name, prefix);
      const sourceParts = options?.ranking?.role === "source"
        ? getSourceScopeKind(
            item,
            databaseKind,
            options.ranking.effectiveSchema,
            options.ranking.defaultObjectType,
          )
        : undefined;
      const matchRank = sourceParts
        ? String(completionRank ?? 0)
        : prefix && completionRank !== 0
          ? `${completionRank ?? 9}_`
          : "";
      const sortText = sourceParts
        ? buildObjectSortText({
            scope: sourceParts.scope,
            kind: sourceParts.kind,
            matchRank: completionRank ?? 0,
            name: item.name,
            ...(preference?.kind === "boost" && preference.band !== undefined
              ? { band: preference.band }
              : {}),
            ...(preference?.kind === "demote"
              ? { band: OBJECT_BANDS.demote }
              : {}),
            ...(learnedBand !== undefined ? { band: learnedBand } : {}),
            ...(preference?.kind === "pin" && preference.pinOrder !== undefined
              ? { pinOrder: preference.pinOrder }
              : {}),
            emitNeutralBand: preferencesActive,
          })
        : `${sortPrefix}${matchRank}${item.name}`;
      return [attachCompletionDescription(
        {
          label: item.name,
          kind: kindOverride || toCompletionKind(item.objectType),
          detail,
          sortText,
          insertText,
          ...(item.database || item.schema
            ? {
                data: {
                  database: item.database,
                  schema: item.schema,
                  objectType: item.objectType,
                },
              }
            : {}),
          // Selecting a personalized FROM source is half-weight preference
          // evidence; it never creates a manual preference or a JOIN relation.
          ...(sourceParts
            && options?.ranking?.personalizeFromObjects === true
            && isObjectPersonalizationEnabled()
            ? {
                command: {
                  title: "Remember selected FROM suggestion",
                  command: "netezza.recordSqlObjectAcceptance",
                  arguments: [{
                    object: {
                      ...(item.database ? { database: item.database } : {}),
                      ...(item.schema ? { schema: item.schema } : {}),
                      name: item.name,
                    },
                    ...(databaseKind ? { databaseKind } : {}),
                    ...(options.ranking.effectiveDatabase
                      ? { effectiveDatabase: options.ranking.effectiveDatabase }
                      : {}),
                    ...(options.ranking.effectiveSchema
                      ? { effectiveSchema: options.ranking.effectiveSchema }
                      : {}),
                  }],
                },
              }
            : {}),
        },
        item.description,
      )];
    });
}

export type MetadataCompletionRole =
  | "database"
  | "location"
  | "schema"
  | "source";

export interface MetadataCompletionRanking {
  role: MetadataCompletionRole;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  defaultObjectType?: NonNullable<MetadataObjectItem["objectType"]>;
  /** Apply manual FROM-object preferences; false for INSERT/UPDATE/ALTER targets. */
  personalizeFromObjects?: boolean;
}

function getMetadataSortPrefix(
  item: MetadataObjectItem,
  databaseKind: DatabaseKind | undefined,
  ranking: MetadataCompletionRanking | undefined,
): string | undefined {
  if (!ranking) {
    return undefined;
  }

  switch (ranking.role) {
    case "database":
    case "location":
      return namesEqual(item.name, ranking.effectiveDatabase, databaseKind)
        ? "0_000_"
        : "0_100_";
    case "schema":
      return namesEqual(item.name, ranking.effectiveSchema, databaseKind)
        ? "0_200_"
        : "0_300_";
    case "source":
      return getSourceSortPrefix(
        item,
        databaseKind,
        ranking.effectiveSchema,
        ranking.defaultObjectType,
      );
  }
}

function getSourceSortPrefix(
  item: MetadataObjectItem,
  databaseKind: DatabaseKind | undefined,
  effectiveSchema: string | undefined,
  defaultObjectType: NonNullable<MetadataObjectItem["objectType"]> | undefined,
): string {
  const parts = getSourceScopeKind(
    item,
    databaseKind,
    effectiveSchema,
    defaultObjectType,
  );
  // Netezza system views remain available but always follow user objects.
  return parts ? `3_${parts.scope}${parts.kind}_` : "9_";
}

function getSourceScopeKind(
  item: MetadataObjectItem,
  databaseKind: DatabaseKind | undefined,
  effectiveSchema: string | undefined,
  defaultObjectType: NonNullable<MetadataObjectItem["objectType"]> | undefined,
): { scope: "0" | "1"; kind: string } | undefined {
  // Netezza system views deliberately stay in the fixed `9_` bucket, so
  // object preferences never move them ahead of user objects.
  if (databaseKind === "netezza" && item.name.startsWith("_V_")) {
    return undefined;
  }

  const isActiveSchema =
    !effectiveSchema ||
    !item.schema ||
    namesEqual(item.schema, effectiveSchema, databaseKind);
  const scope = isActiveSchema ? "0" : "1";

  switch (item.objectType ?? defaultObjectType) {
    case "table":
      return { scope, kind: "00" };
    case "view":
    case "materialized-view":
      return { scope, kind: "10" };
    case "synonym":
      return {
        scope,
        kind: item.schema?.toUpperCase() === "PUBLIC" ? "30" : "20",
      };
    case "procedure":
      return { scope, kind: "40" };
    default:
      return { scope, kind: "90" };
  }
}

function namesEqual(
  left: string | undefined,
  right: string | undefined,
  databaseKind: DatabaseKind | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  if (
    databaseKind === "postgresql" ||
    databaseKind === "vertica" ||
    databaseKind === "duckdb" ||
    databaseKind === "file"
  ) {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left.toUpperCase() === right.toUpperCase();
}

export function toCompletionKind(
  objectType: MetadataObjectItem["objectType"],
): CompletionItemKind {
  if (objectType === "view") {
    return CompletionItemKind.Interface;
  }
  if (objectType === "materialized-view") {
    return CompletionItemKind.Interface;
  }
  if (objectType === "synonym") {
    return CompletionItemKind.Reference;
  }
  if (objectType === "procedure") {
    return CompletionItemKind.Function;
  }
  return CompletionItemKind.Class;
}

export function filterOracleSchemaItems(
  items: MetadataObjectItem[],
  prefix: string,
  currentSchema?: string,
): CompletionItem[] {
  return sortOracleCompletionItems(filterMetadataItems(items, prefix, CompletionItemKind.Module, "oracle", {
    ranking: {
      role: "schema",
      effectiveSchema: currentSchema,
    },
  }));
}

export function filterOracleSourceItems(
  items: MetadataObjectItem[],
  prefix: string,
  currentSchema?: string,
  personalizeFromObjects = false,
): CompletionItem[] {
  return sortOracleCompletionItems(filterMetadataItems(items, prefix, undefined, "oracle", {
    ranking: {
      role: "source",
      effectiveSchema: currentSchema,
      personalizeFromObjects,
    },
  }));
}

function sortOracleCompletionItems(items: CompletionItem[]): CompletionItem[] {
  return items.sort((left, right) =>
    (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label),
  );
}
