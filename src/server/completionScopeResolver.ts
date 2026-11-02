import { normalizePostgresqlIdentifier } from "@justybase/sql-core/postgresqlLexical";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import { SqlLexer } from "../sqlParser";
import type { DatabaseKind } from "../contracts/database";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import type { MetadataColumnItem } from "../lsp/protocol";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import {
  createNetezzaUserIdentifier,
  formatNetezzaIdentifier,
} from "../dialects/netezza/metadata/identifierUtils";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import {
  parseSemanticScopeWithParser,
  type ParserSemanticScope,
} from "../providers/parsers/parserSqlContext";
import { toDocumentParseRequestFromParts } from "./documentParseRequest";
import type { AliasInfo, LocalDefinition } from "../providers/types";
import {
  buildContextualKeywordItems,
  buildExpressionClauseKeywordItems,
  buildExpressionFunctionItems,
  buildExpressionSpecialValueItems,
  isAliasNamePosition,
  isNumericAggregateQualifierPosition,
  resolveExpressionClauseContext,
  resolveOperandContinuationKeywords,
} from "./completionExpressionAnalyzer";
import { dedupeCompletionItems, getCompletionMatchRank } from "./completionRanker";
import {
  isIdentifierToken,
} from "./completionCstUtils";
import {
  parseQualifiedTableNameFromTokens,
  stripQuotes,
} from "./completionDialectAdapter";
import { findLocalDefinition } from "./completionLocalDefinitionUtils";
import {
  applyPrefixRange,
  toColumnItems,
  toRankedMetadataColumnItems,
  toLocalVariableItems,
  toKeywordItems,
  toScopedColumnItems,
} from "./completionRenderer";
import {
  formatJoinTargetPath,
  getJoinAliasBase,
  matchesJoinTableIdentity,
} from "./completionJoinRelationUtils";
import {
  findJoinColumnMatches,
  normalizeJoinColumnName,
} from "./completionJoinConditions";
import { parseQualifierPathToSource } from "./completionQualifierUtils";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { handleVariableCompletion } from "./completionVariableResolver";
import { DEFAULT_JOIN_COMPLETION_SETTINGS } from "../lsp/joinCompletionSettings";
import {
  buildJoinSortText,
  canonicalizeRelation,
  joinColumnPairExactness,
  joinTableSchemaAgreement,
  resolveJoinPredicateTier,
  resolveJoinTargetTier,
  scoreJoinCandidate,
  JOIN_TARGET_REDUNDANT_TIER,
  type JoinTargetRole,
  type JoinTierSources,
} from "@justybase/sql-core/joinKnowledge";
import {
  getConfirmedRelations,
  getFavoriteRelations,
  getColumnUsageBands,
  getRelationEvidenceStrength,
  hasRelationEvidence,
  getRelationScoreAdjustment,
  getRelationDecision,
  getObservedRelations,
  type ObservedJoinRelation,
} from "./joinKnowledgeRanking";
import { getUniqueTableAlias } from "../sql/tableAliasPolicy";
import { isSelfNamedKeyColumn } from "../utils/relatedColumnNames";
import { extractWorkspaceSql } from "../knowledge/workspaceSqlExtractor";
import { extractGroupableSelectExpressions, extractSelectOutputAliases } from "./completionSelectList";
import type {
  CompletionRequestContext,
  ScopeSource,
  ScopedColumnCandidate,
  StatementBoundary,
} from "./completionTypes";

interface DirectJoinSource extends ScopeSource {
  kind: "from" | "join";
  qualifierQuoted?: boolean;
}

function formatDirectJoinQualifier(source: DirectJoinSource, databaseKind?: DatabaseKind): string {
  if (databaseKind === "netezza") {
    return formatNetezzaIdentifier(createNetezzaUserIdentifier(source.qualifier, source.qualifierQuoted));
  }
  return formatIdentifierForSql(source.qualifier, databaseKind);
}

interface JoinScoreSource {
  db?: string;
  schema?: string;
  table: string;
}

/**
 * Within-tier JOIN score (`01-ranking-model.md` §1). Evidence strength is
 * precomputed at snapshot build; the context factors here are in-memory
 * comparisons only (no I/O, parsing or metadata calls).
 */
function relationRankingScore(input: {
  relationKey: string | undefined;
  /**
   * Key canonicalized without the effective scope. Workspace and executed
   * evidence written unqualified is stored under this key.
   */
  unscopedRelationKey?: string;
  pairs: ReadonlyArray<{ left: string; right: string }>;
  source: JoinScoreSource;
  target: { database?: string; schema?: string; table: string };
  proximity: number;
  /** Catalog role of the target; inferred from key names when absent. */
  targetRole?: JoinTargetRole;
  alreadyJoined?: boolean;
  defaults: { database?: string; schema?: string };
}): number {
  return scoreJoinCandidate({
    evidence: getRelationEvidenceStrength(input.relationKey)
      ?? getRelationEvidenceStrength(input.unscopedRelationKey),
    columnPairExactness: joinColumnPairExactness(input.pairs, input.source.table, input.target.table),
    tableSchemaAgreement: joinTableSchemaAgreement(
      { database: input.source.db, schema: input.source.schema },
      input.target,
      input.defaults,
    ),
    contextSimilarity: input.proximity,
    targetRole: input.targetRole
      ?? inferJoinTargetRole(input.pairs, input.source.table, input.target.table),
    alreadyJoined: input.alreadyJoined,
    userAdjustment: getRelationScoreAdjustment(input.relationKey),
  });
}

/**
 * Role from key naming when no catalog FK says it: the side whose columns are
 * named after their own table (`DIMPRODUCT.PRODUCTKEY`) is the parent.
 */
function inferJoinTargetRole(
  pairs: ReadonlyArray<{ left: string; right: string }>,
  sourceTable: string,
  targetTable: string,
): JoinTargetRole {
  if (pairs.length === 0) {
    return "peer";
  }
  const targetOwnsKey = pairs.every((pair) => isSelfNamedKeyColumn(pair.right, targetTable));
  const sourceOwnsKey = pairs.every((pair) => isSelfNamedKeyColumn(pair.left, sourceTable));
  return targetOwnsKey === sourceOwnsKey ? "peer" : targetOwnsKey ? "parent" : "child";
}

/** Table-name level signature of a relation, independent of direction. */
function relationSignature(
  leftTable: string,
  rightTable: string,
  pairs: ReadonlyArray<{ left: string; right: string }>,
): string | undefined {
  const left = leftTable.toUpperCase();
  const right = rightTable.toUpperCase();
  if (left === right || pairs.length === 0) {
    return undefined;
  }
  const ordered = left < right;
  const columns = pairs
    .map((pair) => ordered
      ? `${pair.left.toUpperCase()}=${pair.right.toUpperCase()}`
      : `${pair.right.toUpperCase()}=${pair.left.toUpperCase()}`)
    .sort();
  return `${ordered ? left : right}|${ordered ? right : left}|${columns.join(",")}`;
}

/** Relations already written in the statement before the trailing `JOIN`. */
function statementRelationSignatures(
  statementBeforeJoin: string,
  databaseKind: DatabaseKind | undefined,
): Set<string> {
  const signatures = new Set<string>();
  if (!/\bON\b/i.test(statementBeforeJoin)) {
    return signatures;
  }
  const extraction = extractWorkspaceSql(statementBeforeJoin, {
    databaseKind,
    fingerprint: () => "",
    maxStatements: 1,
  });
  for (const { relation } of extraction.relations) {
    const [first] = relation.columnPairs;
    if (!first) continue;
    const signature = relationSignature(
      first.leftTable.table,
      first.rightTable.table,
      relation.columnPairs.map((pair) => ({ left: pair.leftColumn, right: pair.rightColumn })),
    );
    if (signature) signatures.add(signature);
  }
  return signatures;
}

/** Combined role of the matches forming one condition. */
function combineTargetRoles(roles: ReadonlyArray<JoinTargetRole | undefined>): JoinTargetRole | undefined {
  if (roles.length === 0 || roles.some((role) => role === undefined)) {
    return undefined;
  }
  return roles.every((role) => role === roles[0]) ? roles[0] : "peer";
}

/** Evidence lookup key as written, without applying the effective scope. */
function unscopedRelationKey(
  left: { database?: string; schema?: string; table: string },
  right: { database?: string; schema?: string; table: string },
  pairs: ReadonlyArray<{ left: string; right: string }>,
  databaseKind: DatabaseKind | undefined,
): string | undefined {
  if (!hasRelationEvidence()) {
    return undefined;
  }
  return canonicalizeRelation({ left, right, columns: [...pairs] }, databaseKind)?.key;
}

/** `1` for the most recently written source, `1/2` for the one before, ... */
function sourceProximity<T>(sources: readonly T[], source: T): number {
  const index = sources.indexOf(source);
  return index < 0 ? 0 : 1 / (sources.length - index);
}

function describeObservedSource(observed: ObservedJoinRelation): string {
  return observed.source === "executed" ? "successful executions" : "workspace SQL";
}

function describeObservedJoin(observed: ObservedJoinRelation): string {
  return `JOIN found in ${describeObservedSource(observed)} (${observed.breadth})`;
}

/** Executed evidence ranks in `0_4_`; workspace evidence stays in `0_5_`. */
function observedTierSources(observed: ObservedJoinRelation): JoinTierSources {
  return observed.source === "executed" ? { executed: true } : { workspace: true };
}

function normalizeRelationColumnName(name: string): string {
  return normalizeJoinColumnName(name);
}

/**
 * Right after `GROUP BY`, one item inserting every non-aggregated SELECT
 * expression (Redgate SQL Prompt / DataGrip style).
 */
function buildGroupBySelectListItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
): CompletionItem[] {
  const beforeTyped = typedPrefix ? statementPrefix.slice(0, -typedPrefix.length) : statementPrefix;
  if (!/\bGROUP\s+BY\s*$/i.test(beforeTyped)) {
    return [];
  }
  const expressions = extractGroupableSelectExpressions(statementPrefix);
  if (expressions.length === 0) {
    return [];
  }
  const label = expressions.join(", ");
  if (typedPrefix && !label.toUpperCase().startsWith(typedPrefix.toUpperCase())) {
    return [];
  }
  const item: CompletionItem = {
    label,
    kind: CompletionItemKind.Snippet,
    detail: "Non-aggregated SELECT items",
    insertText: label,
    sortText: "0_group_by_select_list",
  };
  applyPrefixRange(item, position, typedPrefix);
  return [item];
}

export interface QualifierCompletionRequest {
  qualifier: string;
  statement: StatementBoundary | null;
  statementOffset: number;
  documentText: string;
  cursorOffset: number;
  localDefs: LocalDefinition[];
  resolutionLocalDefs: LocalDefinition[];
  documentUri: string;
  documentVersion: number;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  databaseKind?: DatabaseKind;
}

export interface SemanticScopeCompletionRequest {
  statement: StatementBoundary | null;
  statementOffset: number;
  statementPrefix: string;
  linePrefix: string;
  position: Position;
  triggerKind?: CompletionTriggerKind;
  localDefs: LocalDefinition[];
  documentUri: string;
  documentVersion: number;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  joinCompletionSettings?: CompletionRequestContext["joinCompletionSettings"];
  databaseKind?: DatabaseKind;
  completionKeywords: readonly string[];
  sqlFunctionNames: readonly string[];
  sqlFunctionSignatures: ReadonlyMap<
    string,
    readonly DatabaseSqlFunctionSignature[]
  >;
  specialBuiltinValues: readonly string[];
}

/**
 * Resolves scope-aware column completions, alias bindings, and expression suggestions.
 */
export class CompletionScopeResolver {
  constructor(
    private readonly contextExtractor: CompletionContextExtractor,
    private readonly metadataResolver: CompletionMetadataResolver,
    private readonly parseSession?: DocumentParseSession,
  ) {}

  /** Return only key/name matched predicates for an automatic space trigger. */
  public async getJoinConditionCompletions(
    request: CompletionRequestContext,
  ): Promise<CompletionItem[]> {
    const {
      statementPrefix,
      linePrefix,
      position,
      localDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
      joinCompletionSettings = DEFAULT_JOIN_COMPLETION_SETTINGS,
    } = request;
    const tokens = SqlLexer.tokenize(statementPrefix).tokens;
    const lastToken = tokens[tokens.length - 1];
    if (
      resolveExpressionClauseContext(statementPrefix) !== "on" ||
      this.contextExtractor.extractCurrentIdentifierPrefix(linePrefix) !== "" ||
      lastToken?.image.toUpperCase() !== "ON"
    ) {
      return [];
    }

    return this.buildJoinConditionItems(
      statementPrefix,
      localDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
      joinCompletionSettings,
      position,
    );
  }

  /** Suggest only cache-backed related tables after an automatic `JOIN ` trigger. */
  public async getJoinTargetCompletions(
    request: CompletionRequestContext,
  ): Promise<CompletionItem[] | undefined> {
    const {
      statementPrefix,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      joinCompletionSettings = DEFAULT_JOIN_COMPLETION_SETTINGS,
    } = request;
    const tokens = SqlLexer.tokenize(statementPrefix).tokens;
    const joinToken = tokens[tokens.length - 1];
    if (joinToken?.tokenType.name !== "Join") {
      return undefined;
    }
    const sources = this.extractDirectJoinSources(statementPrefix, databaseKind);
    const writtenRelations = statementRelationSignatures(
      statementPrefix.slice(0, joinToken.startOffset),
      databaseKind,
    );
    // `addJoinCompletion` shadows `sources` with its tier sources.
    const directJoinSources = sources;
    const sourcesByDatabase = new Map<
      string,
      { database: string; sources: Array<{ schema?: string; table: string }> }
    >();
    for (const source of sources) {
      const database = source.db ?? effectiveDb;
      if (!database) continue;
      const key = database.toUpperCase();
      const group = sourcesByDatabase.get(key) ?? { database, sources: [] };
      group.sources.push({ schema: source.schema, table: source.table });
      sourcesByDatabase.set(key, group);
    }

    const usedAliases = new Set<string>(
      request.localDefs.map((definition) =>
        definition.name.replace(/^"|"$/g, "").toUpperCase(),
      ),
    );
    for (const source of sources) {
      usedAliases.add(source.qualifier.replace(/^"|"$/g, "").toUpperCase());
    }

    const relatedItems = new Map<string, CompletionItem>();
    const relationDefaults = {
      database: effectiveDb,
      schema: effectiveSchema,
    };
    const addJoinCompletion = (
      target: { database?: string; schema?: string; table: string },
      source: DirectJoinSource,
      pairs: Array<{ sourceColumn: string; targetColumn: string }>,
      detail: string,
      sources: JoinTierSources,
      joinUsesDefaultSchema = false,
      targetRole?: JoinTargetRole,
    ): void => {
      if (pairs.length === 0) return;
      const targetIdentity = {
        database: target.database ?? effectiveDb,
        schema: target.schema ?? effectiveSchema,
        table: target.table,
      };
      const sourceIdentity = {
        database: source.db ?? effectiveDb,
        schema: source.schema ?? effectiveSchema,
        table: source.table,
      };
      const decision = getRelationDecision(
        sourceIdentity,
        targetIdentity,
        pairs.map((pair) => ({
          left: pair.sourceColumn,
          right: pair.targetColumn,
        })),
        databaseKind,
        relationDefaults,
      );
      // Block is applied before tiering: a blocked relation never reaches
      // ranking, including a relation that is also present in workspace
      // `joinRelations`. Reverting the block restores the configured entry.
      if (decision.decision === "blocked") {
        return;
      }
      const resolvedTier = resolveJoinTargetTier({
        ...sources,
        confirmed: sources.confirmed === true || decision.decision === "confirmed",
      });
      if (!resolvedTier.ranked) {
        return;
      }
      const signature = relationSignature(
        source.table,
        target.table,
        pairs.map((pair) => ({ left: pair.sourceColumn, right: pair.targetColumn })),
      );
      const tier = signature && writtenRelations.has(signature)
        ? { ...resolvedTier, tier: JOIN_TARGET_REDUNDANT_TIER }
        : resolvedTier;
      const favorite = tier.source === "favorite"
        || decision.decision === "favorite";
      const detailText = favorite && tier.source !== "confirmed"
        ? `${detail} • favorite`
        : detail;
      const relationData = {
        left: sourceIdentity,
        right: targetIdentity,
        columns: pairs.map((pair) => ({
          left: pair.sourceColumn,
          right: pair.targetColumn,
        })),
        databaseKind,
        effectiveDatabase: effectiveDb,
        effectiveSchema: effectiveSchema,
      };
      const candidateKey = `${decision.key ?? `${sourceIdentity.table}>${targetIdentity.table}`}|${source.qualifier.toLocaleUpperCase()}`;
      const existing = relatedItems.get(candidateKey);
      // A target already present in the statement is rarely joined again;
      // a self-relation needs two occurrences before it counts as joined.
      const targetOccurrences = directJoinSources.filter((candidate) =>
        matchesJoinTableIdentity(
          targetIdentity,
          { database: candidate.db, schema: candidate.schema, table: candidate.table },
          effectiveDb,
          effectiveSchema,
        )).length;
      const selfRelation = matchesJoinTableIdentity(
        targetIdentity,
        sourceIdentity,
        effectiveDb,
        effectiveSchema,
      );
      const scorePairs = pairs.map((pair) => ({ left: pair.sourceColumn, right: pair.targetColumn }));
      const score = relationRankingScore({
        relationKey: decision.key,
        unscopedRelationKey: unscopedRelationKey(
          { database: source.db, schema: source.schema, table: source.table },
          target,
          scorePairs,
          databaseKind,
        ),
        pairs: scorePairs,
        source,
        target: targetIdentity,
        proximity: sourceProximity(directJoinSources, source),
        targetRole,
        alreadyJoined: targetOccurrences >= (selfRelation ? 2 : 1),
        defaults: relationDefaults,
      });
      if (existing) {
        // A lower tier prefix wins regardless of insertion order. Reuse the
        // existing label so alias allocation is stable.
        const nextSortText = buildJoinSortText(tier.tier, existing.label, score);
        if (nextSortText < String(existing.sortText ?? "")) {
          existing.sortText = nextSortText;
          existing.detail = detailText;
          existing.data = {
            ...(existing.data && typeof existing.data === "object" ? existing.data : {}),
            joinKnowledgeRelation: relationData,
            joinKnowledgeFavorite: favorite,
          };
        }
        return;
      }
      const configuredAlias = joinCompletionSettings.aliases.find((entry) =>
        matchesJoinTableIdentity(entry.table, targetIdentity, effectiveDb, effectiveSchema),
      )?.alias;
      const isConfiguredAlias = configuredAlias !== undefined;
      const preferredAlias = configuredAlias
        ?? (joinCompletionSettings.autoAliases ? getJoinAliasBase(target.table) : undefined);
      let alias: string | undefined;
      if (preferredAlias) {
        alias = this.getUniqueJoinAlias(preferredAlias, usedAliases);
      }
      const targetPath = formatJoinTargetPath(
        targetIdentity,
        databaseKind,
        effectiveDb,
        joinUsesDefaultSchema,
      );
      const targetQualifier = alias
        ? (isConfiguredAlias
          ? formatDirectJoinQualifier({ qualifier: alias, table: target.table, kind: "join" }, databaseKind)
          : alias)
        : formatDirectJoinQualifier({ qualifier: target.table, table: target.table, kind: "join" }, databaseKind);
      const prefix = alias ? `${targetPath} ${targetQualifier}` : targetPath;
      const predicates = pairs.map((pair) =>
        `${formatDirectJoinQualifier(source, databaseKind)}.${formatIdentifierForSql(pair.sourceColumn, databaseKind)} = ${targetQualifier}.${formatIdentifierForSql(pair.targetColumn, databaseKind)}`,
      );
      const label = `${prefix} ON ${predicates.join(" AND ")}`;
      relatedItems.set(candidateKey, {
        label,
        kind: CompletionItemKind.Class,
        detail: detailText,
        sortText: buildJoinSortText(tier.tier, label, score),
        insertText: label,
        data: {
          joinKnowledgeRelation: relationData,
          joinKnowledgeFavorite: favorite,
        },
      });
    };

    // Workspace relations are authoritative, direction-independent and preserve
    // explicit column pairs (including composite keys and different names).
    for (const relation of joinCompletionSettings.relations) {
      for (const source of sources) {
        const sourceIdentity = {
          database: source.db,
          schema: source.schema,
          table: source.table,
        };
        if (matchesJoinTableIdentity(relation.left, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.right,
            source,
            relation.columns.map((pair) => ({ sourceColumn: pair.left, targetColumn: pair.right })),
            "JOIN with configured relationship",
            { manual: true },
          );
        }
        if (matchesJoinTableIdentity(relation.right, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.left,
            source,
            relation.columns.map((pair) => ({ sourceColumn: pair.right, targetColumn: pair.left })),
            "JOIN with configured relationship",
            { manual: true },
          );
        }
      }
    }

    // Explicitly confirmed relations are available even when no catalog FK or
    // cached key/name metadata exists. They rank below configured relations
    // and above catalog FK.
    for (const relation of getConfirmedRelations()) {
      for (const source of sources) {
        const sourceIdentity = {
          database: source.db,
          schema: source.schema,
          table: source.table,
        };
        if (matchesJoinTableIdentity(relation.display.left, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.right,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.left,
              targetColumn: pair.right,
            })),
            "JOIN with confirmed relationship",
            { confirmed: true },
          );
        }
        if (matchesJoinTableIdentity(relation.display.right, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.left,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.right,
              targetColumn: pair.left,
            })),
            "JOIN with confirmed relationship",
            { confirmed: true },
          );
        }
      }
    }

    // Favorites are a persistent display preference, never confirmation. They
    // share the `0_3_` preference band and remain below catalog FK.
    for (const relation of getFavoriteRelations()) {
      for (const source of sources) {
        const sourceIdentity = {
          database: source.db,
          schema: source.schema,
          table: source.table,
        };
        if (matchesJoinTableIdentity(relation.display.left, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.right,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.left,
              targetColumn: pair.right,
            })),
            "JOIN with favorite relationship",
            { favorite: true },
          );
        }
        if (matchesJoinTableIdentity(relation.display.right, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.left,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.right,
              targetColumn: pair.left,
            })),
            "JOIN with favorite relationship",
            { favorite: true },
          );
        }
      }
    }

    // Observed relations (successful executions, then workspace SQL) are
    // evidence only. Both are filtered below their thresholds upstream.
    for (const observed of getObservedRelations(databaseKind)) {
      const relation = observed.relation;
      for (const source of sources) {
        const sourceIdentity = {
          database: source.db,
          schema: source.schema,
          table: source.table,
        };
        if (matchesJoinTableIdentity(relation.display.left, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.right,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.left,
              targetColumn: pair.right,
            })),
            describeObservedJoin(observed),
            observedTierSources(observed),
          );
        }
        if (matchesJoinTableIdentity(relation.display.right, sourceIdentity, effectiveDb, effectiveSchema)) {
          addJoinCompletion(
            relation.display.left,
            source,
            relation.display.columns.map((pair) => ({
              sourceColumn: pair.right,
              targetColumn: pair.left,
            })),
            describeObservedJoin(observed),
            observedTierSources(observed),
          );
        }
      }
    }

    {
      for (const { database, sources: databaseSources } of sourcesByDatabase.values()) {
        const relatedTables = await this.metadataResolver.getCachedJoinTargets(
          documentUri,
          database,
          databaseSources,
        );
        for (const table of relatedTables) {
          const groupedMatches = new Map<string, {
            source: DirectJoinSource;
            pairs: Array<{
              sourceColumn: string;
              targetColumn: string;
              ordinalPosition?: number;
            }>;
            relationType: "foreignKey" | "heuristic";
            constraintName?: string;
            roles: Array<JoinTargetRole | undefined>;
          }>();
          for (const match of table.joinMatches ?? []) {
            const relationType = match.relationType ?? "heuristic";
            if (!joinCompletionSettings.nameHeuristicsEnabled && relationType !== "foreignKey") continue;
            const source = sources.find((candidate) =>
              candidate.table.toUpperCase() === match.sourceTable.toUpperCase() &&
              (!match.sourceSchema || !candidate.schema ||
                candidate.schema.toUpperCase() === match.sourceSchema.toUpperCase()),
            );
            if (!source) continue;
            const groupKey = `${source.qualifier.toUpperCase()}|${table.schema?.toUpperCase() ?? ""}|${table.name.toUpperCase()}|${relationType}|${match.constraintName?.toUpperCase() ?? ""}|${match.group ?? ""}`;
            const group = groupedMatches.get(groupKey) ?? {
              source,
              pairs: [],
              relationType,
              constraintName: match.constraintName,
              roles: [],
            };
            group.roles.push(match.targetRole);
            group.pairs.push({
              sourceColumn: match.sourceColumn,
              targetColumn: match.targetColumn,
              ordinalPosition: match.ordinalPosition,
            });
            groupedMatches.set(groupKey, group);
          }
          for (const { source, pairs, relationType, roles } of groupedMatches.values()) {
            const orderedPairs = relationType === "foreignKey"
              ? [...pairs].sort((left, right) =>
                (left.ordinalPosition ?? Number.MAX_SAFE_INTEGER)
                - (right.ordinalPosition ?? Number.MAX_SAFE_INTEGER),
              )
              : pairs;
            addJoinCompletion(
              { database: table.database ?? database, schema: table.schema, table: table.name },
              source,
              orderedPairs,
              relationType === "foreignKey"
                ? "JOIN with declared foreign key"
                : "JOIN with cached key/name match",
              relationType === "foreignKey" ? { catalogFk: true } : {},
              table.joinUsesDefaultSchema === true,
              combineTargetRoles(roles),
            );
          }
        }
      }
    }
    return [...relatedItems.values()].sort((left, right) =>
      (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label),
    );
  }

  private getUniqueJoinAlias(preferred: string, usedAliases: Set<string>): string {
    return getUniqueTableAlias(preferred, usedAliases);
  }

  public async resolveColumnsForQualifier(
    request: QualifierCompletionRequest,
  ): Promise<CompletionItem[]> {
    const {
      qualifier,
      statement,
      statementOffset,
      documentText,
      cursorOffset,
      localDefs,
      resolutionLocalDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
    } = request;

    const preparedStatement = statement
      ? this.contextExtractor.prepareParserFriendlySql(
          statement.sql,
          statementOffset,
          databaseKind,
        )
      : this.contextExtractor.prepareParserFriendlySql(
          documentText,
          cursorOffset,
          databaseKind,
        );
    const parserFriendlyDocument = this.contextExtractor.prepareParserFriendlySql(
      documentText,
      cursorOffset,
      databaseKind,
    ).sql;
    const aliasBindingsRaw = this.mergeAliasMaps(
      this.getAliasBindings(
        documentUri,
        request.documentVersion,
        preparedStatement.sql,
        preparedStatement.cursorOffset,
        databaseKind,
      ),
      this.extractAdditionalAliasBindings(
        preparedStatement.sql,
        preparedStatement.cursorOffset,
        databaseKind,
      ),
    );

    let aliasBindingsToUse = aliasBindingsRaw;
    if (aliasBindingsRaw.size === 0) {
      const globalAlias = this.mergeAliasMaps(
        this.getAliasBindings(
          documentUri,
          request.documentVersion,
          preparedStatement.sql,
          undefined,
          databaseKind,
        ),
        this.extractAdditionalAliasBindings(preparedStatement.sql, undefined, databaseKind),
      );
      if (globalAlias.size > 0) {
        aliasBindingsToUse = globalAlias;
      }
    }

    const aliasBindings = this.resolveAliasBindingsFully(aliasBindingsToUse, databaseKind);
    const clausePrefix = statement ? statement.sql.slice(0, statementOffset) : documentText.slice(0, cursorOffset);
    const clause = isNumericAggregateQualifierPosition(clausePrefix)
      ? "aggregate"
      : resolveExpressionClauseContext(clausePrefix);

    const qualifiedSource = parseQualifierPathToSource(qualifier, databaseKind);
    if (qualifiedSource && qualifier.includes(".")) {
      const qualifiedColumns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        qualifiedSource,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        this.buildMetadataColumnOptions(netezzaSchemasEnabled),
      );
      return toRankedMetadataColumnItems(
        qualifiedColumns,
        this.columnUsageBandsFor(qualifiedSource, effectiveDb, effectiveSchema, databaseKind),
        { clause, table: qualifiedSource.table },
      );
    }

    const localDefinition = findLocalDefinition(localDefs, qualifier);
    if (localDefinition) {
      const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
        localDefinition,
        parserFriendlyDocument,
        resolutionLocalDefs,
        documentUri,
        request.documentVersion,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        new Set<string>(),
      );
      if (resolvedColumns.length > 0) {
        return toColumnItems(resolvedColumns);
      }
    }

    const rawAliasBinding = aliasBindingsRaw.get(databaseKind === "postgresql" ? normalizePostgresqlIdentifier(qualifier) : qualifier.toUpperCase());
    if (rawAliasBinding) {
      const rawLocalAliasTarget = findLocalDefinition(localDefs, rawAliasBinding.table);
      if (rawLocalAliasTarget) {
        const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
          rawLocalAliasTarget,
          parserFriendlyDocument,
          resolutionLocalDefs,
          documentUri,
          request.documentVersion,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          new Set<string>(),
        );
        if (resolvedColumns.length > 0) {
          return toColumnItems(resolvedColumns);
        }
      }
    }

    const aliasBinding = aliasBindings.get(databaseKind === "postgresql" ? normalizePostgresqlIdentifier(qualifier) : qualifier.toUpperCase());
    if (aliasBinding) {
      const localAliasTarget = findLocalDefinition(localDefs, aliasBinding.table);
      if (localAliasTarget) {
        const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
          localAliasTarget,
          parserFriendlyDocument,
          resolutionLocalDefs,
          documentUri,
          request.documentVersion,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          new Set<string>(),
        );
        if (resolvedColumns.length > 0) {
          return toColumnItems(resolvedColumns);
        }
      }

      const columns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        aliasBinding,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        this.buildMetadataColumnOptions(netezzaSchemasEnabled),
      );
      return toRankedMetadataColumnItems(
        columns,
        this.columnUsageBandsFor(aliasBinding, effectiveDb, effectiveSchema, databaseKind),
        { clause, table: aliasBinding.table },
      );
    }

    const directColumns = await this.metadataResolver.getMetadataColumnsForSource(
      documentUri,
      { table: qualifier },
      effectiveDb,
      effectiveSchema,
      databaseKind,
      {
        omitSchemaArgumentWhenUndefined: true,
        netezzaSchemasEnabled,
      },
    );
    return toRankedMetadataColumnItems(
      directColumns,
      this.columnUsageBandsFor({ table: qualifier }, effectiveDb, effectiveSchema, databaseKind),
      { clause, table: qualifier },
    );
  }

  /** Learned column bands for one source table; map lookups only. */
  private columnUsageBandsFor(
    source: { db?: string; schema?: string; table: string },
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind: DatabaseKind | undefined,
  ): ReadonlyMap<string, number> | undefined {
    return getColumnUsageBands(
      { database: source.db, schema: source.schema, name: source.table },
      databaseKind,
      { database: effectiveDb, schema: effectiveSchema },
    );
  }

  public async getSemanticScopeCompletions(
    request: SemanticScopeCompletionRequest,
  ): Promise<CompletionItem[] | undefined> {
    const {
      statement,
      statementOffset,
      statementPrefix,
      linePrefix,
      position,
      triggerKind,
      localDefs,
      documentUri,
      documentVersion,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
      joinCompletionSettings,
      completionKeywords,
      sqlFunctionNames,
      sqlFunctionSignatures,
      specialBuiltinValues,
    } = request;

    const clause = resolveExpressionClauseContext(statementPrefix);
    if (!clause) {
      return undefined;
    }

    const typedPrefix = this.contextExtractor.extractCurrentIdentifierPrefix(
      linePrefix,
    );
    // After a completed FROM/JOIN target (with or without alias) only clause
    // keywords can follow; columns are used later via qualifier paths (A.) or
    // in SELECT/WHERE/GROUP BY/HAVING. Do not show anything on a plain
    // whitespace trigger; keywords become available once a letter is typed or
    // the completion is invoked explicitly (Ctrl+Space).
    if (
      clause === "from" &&
      triggerKind === CompletionTriggerKind.TriggerCharacter &&
      typedPrefix === ""
    ) {
      return [];
    }
    if (
      (clause === "from" || clause === "select") &&
      isAliasNamePosition(statementPrefix, typedPrefix)
    ) {
      return [];
    }
    if (clause === "from") {
      // Live Netezza (Release 11.2.2.1, verified 2026-10-11) accepts
      // `JOIN ... USING (col)`; only columns present on both sides of the
      // current join are valid inside the parentheses.
      const usingColumns = await this.buildUsingCommonColumnItems(
        statementPrefix,
        typedPrefix,
        position,
        localDefs,
        documentUri,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        netezzaSchemasEnabled,
      );
      if (usingColumns) {
        return usingColumns;
      }
      return buildContextualKeywordItems(
        statementPrefix,
        typedPrefix,
        position,
        completionKeywords,
      );
    }
    if (
      clause === "limit" ||
      clause === "offset" ||
      (clause === "values" && typedPrefix === "")
    ) {
      return [];
    }
    // After a completed operand (`WHERE A > 0 |`, `SELECT COL |`,
    // `ORDER BY COL |`) only operators, clause transitions or an alias can
    // follow; columns, functions and variables would be syntax errors.
    const continuationKeywords = resolveOperandContinuationKeywords(
      clause,
      statementPrefix,
      typedPrefix,
      completionKeywords,
      specialBuiltinValues,
    );
    if (continuationKeywords) {
      const allowed = new Set(continuationKeywords);
      return toKeywordItems(typedPrefix, position, completionKeywords).filter(
        (item) => allowed.has(item.label.toUpperCase()),
      );
    }
    const statementSql = statement ? statement.sql : "";
    const parserFriendlyStatementPrepared = statement
      ? this.contextExtractor.prepareParserFriendlySql(
          statementSql,
          statementOffset,
          databaseKind,
        )
      : this.contextExtractor.prepareParserFriendlySql(
          statementPrefix,
          statementPrefix.length,
          databaseKind,
        );

    const aliasBindingsRaw = this.mergeAliasMaps(
      this.getAliasBindings(
        documentUri,
        documentVersion,
        parserFriendlyStatementPrepared.sql,
        parserFriendlyStatementPrepared.cursorOffset,
        databaseKind,
      ),
      this.extractAdditionalAliasBindings(
        parserFriendlyStatementPrepared.sql,
        parserFriendlyStatementPrepared.cursorOffset,
        databaseKind,
      ),
    );
    const aliasBindings = this.resolveAliasBindingsFully(aliasBindingsRaw, databaseKind);
    const scopeSources = this.getPreferredScopeSources(aliasBindings);
    const scopedColumns = await this.collectScopedColumns(
      scopeSources,
      localDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
    );

    if (clause === "having" || clause === "order") {
      // Live Netezza resolves SELECT output aliases in HAVING and ORDER BY;
      // the table scope above does not include them.
      for (const alias of extractSelectOutputAliases(statementPrefix)) {
        if (
          !scopedColumns.some(
            (candidate) =>
              candidate.column.toUpperCase() === alias.toUpperCase(),
          )
        ) {
          scopedColumns.push({ column: alias, qualifiers: [] });
        }
      }
    }

    const columnItems = toScopedColumnItems(scopedColumns, typedPrefix, position);
    const joinConditionItems = clause === "on" && typedPrefix === ""
        ? await this.buildJoinConditionItems(
          statementPrefix,
          localDefs,
          documentUri,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          netezzaSchemasEnabled,
          joinCompletionSettings ?? DEFAULT_JOIN_COMPLETION_SETTINGS,
          position,
        )
      : [];
    const variableItems = toLocalVariableItems(localDefs, typedPrefix, position);
    const functionItems = buildExpressionFunctionItems(
      statementPrefix,
      typedPrefix,
      position,
      sqlFunctionNames,
      sqlFunctionSignatures,
      triggerKind === CompletionTriggerKind.Invoked,
    );
    const clauseKeywordItems = buildExpressionClauseKeywordItems(
      statementPrefix,
      typedPrefix,
      position,
      completionKeywords,
    );
    const contextualKeywordItems = buildContextualKeywordItems(
      statementPrefix,
      typedPrefix,
      position,
      completionKeywords,
    );
    const specialValueItems = buildExpressionSpecialValueItems(
      statementPrefix,
      typedPrefix,
      position,
      specialBuiltinValues,
      triggerKind === CompletionTriggerKind.Invoked,
    );
    const groupByItems = clause === "group"
      ? buildGroupBySelectListItems(statementPrefix, typedPrefix, position)
      : [];
    const items = dedupeCompletionItems([
      ...groupByItems,
      ...joinConditionItems,
      ...columnItems,
      ...variableItems,
      ...functionItems,
      ...specialValueItems,
      ...clauseKeywordItems,
      ...contextualKeywordItems,
    ]);
    if (typedPrefix) {
      // Match quality precedes item kind: a direct function prefix beats an
      // unrelated column fragment; equal matches keep the existing kind order.
      for (const item of items) {
        const rank = getCompletionMatchRank(item.label, typedPrefix) ?? 9;
        item.sortText = `${rank}_${item.sortText ?? item.label}`;
      }
      items.sort((left, right) => (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label));
    }
    return items.length > 0 ? items : undefined;
  }

  public handleVariableCompletion = handleVariableCompletion;

  private getAliasBindings(
    documentUri: string,
    documentVersion: number,
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    let bindings = this.getSemanticScope(
      documentUri,
      documentVersion,
      statementSql,
      cursorOffset,
      databaseKind,
    ).preferredAliasBindings;

    if (
      bindings.size === 0 &&
      cursorOffset !== undefined &&
      cursorOffset > 0 &&
      cursorOffset < statementSql.length
    ) {
      const prefixSql = statementSql.substring(0, cursorOffset);
      bindings = this.getSemanticScope(
        documentUri,
        documentVersion,
        prefixSql,
        prefixSql.length,
        databaseKind,
      ).preferredAliasBindings;
    }

    return bindings;
  }

  private getSemanticScope(
    documentUri: string,
    documentVersion: number,
    sql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): ParserSemanticScope {
    if (this.parseSession) {
      try {
        return this.parseSession.getSemanticScope({
          ...toDocumentParseRequestFromParts(
            documentUri,
            documentVersion,
            sql,
            databaseKind,
          ),
          cursorOffset,
        });
      } catch {
        const emptyBindings = new Map<string, AliasInfo>();
        return {
          aliasBindings: emptyBindings,
          globalAliasBindings: emptyBindings,
          preferredAliasBindings: emptyBindings,
          localDefinitions: [],
          visibleLocalDefinitions: [],
          source: "token",
          hasScopedParserContext: false,
        };
      }
    }

    try {
      return parseSemanticScopeWithParser(sql, cursorOffset, databaseKind);
    } catch {
      const emptyBindings = new Map<string, AliasInfo>();
      return {
        aliasBindings: emptyBindings,
        globalAliasBindings: emptyBindings,
        preferredAliasBindings: emptyBindings,
        localDefinitions: [],
        visibleLocalDefinitions: [],
        source: "token",
        hasScopedParserContext: false,
      };
    }
  }

  private resolveAliasBindingsFully(
    aliasBindings: Map<string, AliasInfo>,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    const resolved = new Map<string, AliasInfo>();
    const resolve = (key: string, seen: Set<string>): AliasInfo | undefined => {
      if (seen.has(key)) {
        return undefined;
      }
      const binding = aliasBindings.get(key);
      if (!binding) {
        return undefined;
      }
      seen.add(key);
      const targetKey = databaseKind === "postgresql" ? binding.table : binding.table.toUpperCase();
      if (targetKey !== key && aliasBindings.has(targetKey)) {
        const deep = resolve(targetKey, seen);
        if (deep) {
          return deep;
        }
      }
      return binding;
    };

    for (const [key, binding] of aliasBindings.entries()) {
      const mapped = resolve(key, new Set<string>());
      resolved.set(key, mapped || binding);
    }
    return resolved;
  }

  private mergeAliasMaps(
    base: Map<string, AliasInfo>,
    extra: Map<string, AliasInfo>,
  ): Map<string, AliasInfo> {
    if (extra.size === 0) {
      return base;
    }

    const merged = new Map<string, AliasInfo>(base);
    for (const [key, value] of extra.entries()) {
      merged.set(key, value);
    }
    return merged;
  }

  private extractAdditionalAliasBindings(
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    return this.parseMergeAliasBindings(statementSql, cursorOffset, databaseKind);
  }

  private parseMergeAliasBindings(
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    const collectBindings = (sql: string): Map<string, AliasInfo> => {
      const bindings = new Map<string, AliasInfo>();
      const lexResult = SqlLexer.tokenize(sql);
      if (lexResult.tokens.length === 0) {
        return bindings;
      }

      const tokens = lexResult.tokens;
      const mergeIndex = tokens.findIndex(
        (token) => token.tokenType.name === "Merge",
      );
      if (mergeIndex < 0) {
        return bindings;
      }

      let scanIndex = mergeIndex + 1;
      if (tokens[scanIndex]?.tokenType.name === "Into") {
        scanIndex += 1;
      }

      const targetRef = parseQualifiedTableNameFromTokens(tokens, scanIndex, databaseKind);
      if (!targetRef) {
        return bindings;
      }
      const targetAliasResult = this.parseAliasAfterTableRef(
        tokens,
        targetRef.nextIndex,
      );
      this.registerAliasBinding(bindings, targetRef.tableRef, targetAliasResult.alias);

      const usingIndex = tokens.findIndex(
        (token, index) =>
          index >= targetAliasResult.nextIndex &&
          token.tokenType.name === "Using",
      );
      if (usingIndex < 0) {
        return bindings;
      }

      const sourceRef = parseQualifiedTableNameFromTokens(tokens, usingIndex + 1, databaseKind);
      if (!sourceRef) {
        return bindings;
      }
      const sourceAliasResult = this.parseAliasAfterTableRef(
        tokens,
        sourceRef.nextIndex,
      );
      this.registerAliasBinding(bindings, sourceRef.tableRef, sourceAliasResult.alias);
      return bindings;
    };

    const primary = collectBindings(statementSql);
    if (
      primary.size > 0 ||
      cursorOffset === undefined ||
      cursorOffset <= 0 ||
      cursorOffset >= statementSql.length
    ) {
      return primary;
    }

    return collectBindings(statementSql.substring(0, cursorOffset));
  }

  private parseAliasAfterTableRef(
    tokens: import("chevrotain").IToken[],
    startIndex: number,
  ): { alias?: string; aliasQuoted?: boolean; nextIndex: number } {
    let index = startIndex;
    if (tokens[index]?.tokenType.name === "As") {
      index += 1;
    }

    const aliasToken = tokens[index];
    if (!isIdentifierToken(aliasToken)) {
      return { nextIndex: index };
    }
    if (this.isMergeAliasBoundaryToken(aliasToken)) {
      return { nextIndex: index };
    }

    return {
      alias: stripQuotes(aliasToken.image),
      aliasQuoted: aliasToken.image.startsWith('"') && aliasToken.image.endsWith('"'),
      nextIndex: index + 1,
    };
  }

  private registerAliasBinding(
    bindings: Map<string, AliasInfo>,
    tableRef: { database?: string; schema?: string; table: string },
    alias?: string,
  ): void {
    const binding: AliasInfo = {
      db: tableRef.database,
      schema: tableRef.schema,
      table: tableRef.table,
    };

    bindings.set(tableRef.table.toUpperCase(), binding);
    if (alias) {
      bindings.set(alias.toUpperCase(), binding);
    }
  }

  private isMergeAliasBoundaryToken(
    token: import("chevrotain").IToken | undefined,
  ): boolean {
    if (!token) {
      return true;
    }

    const boundaryTokenNames = new Set([
      "Using",
      "On",
      "When",
      "Where",
      "Set",
      "Values",
      "Join",
      "Inner",
      "Left",
      "Right",
      "Full",
      "Cross",
      "Natural",
      "Group",
      "Order",
      "Having",
      "Limit",
      "Union",
      "Intersect",
      "Except",
      "Semicolon",
      "Comma",
      "RParen",
    ]);

    return boundaryTokenNames.has(token.tokenType.name);
  }

  private getPreferredScopeSources(
    aliasBindings: Map<string, AliasInfo>,
  ): ScopeSource[] {
    const groups = new Map<
      string,
      { binding: AliasInfo; qualifiers: string[] }
    >();
    aliasBindings.forEach((binding, qualifierName) => {
      const key = `${(binding.db || "").toUpperCase()}|${(binding.schema || "").toUpperCase()}|${binding.table.toUpperCase()}`;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { binding, qualifiers: [qualifierName] });
        return;
      }
      group.qualifiers.push(qualifierName);
    });

    const sources: ScopeSource[] = [];
    groups.forEach((group) => {
      const preferredQualifier =
        group.qualifiers.find(
          (q) => q.toUpperCase() !== group.binding.table.toUpperCase(),
        ) ?? group.qualifiers[0];
      sources.push({
        qualifier: preferredQualifier,
        db: group.binding.db,
        schema: group.binding.schema,
        table: group.binding.table,
      });
    });

    return sources;
  }

  private async buildJoinConditionItems(
    statementPrefix: string,
    localDefs: LocalDefinition[],
    documentUri: string,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind: DatabaseKind | undefined,
    netezzaSchemasEnabled: boolean | undefined,
    joinCompletionSettings: NonNullable<CompletionRequestContext["joinCompletionSettings"]>,
    position: Position,
  ): Promise<CompletionItem[]> {
    const sources = this.extractDirectJoinSources(statementPrefix, databaseKind);
    const joined = sources[sources.length - 1];
    if (!joined || joined.kind !== "join" || sources.length < 2) {
      return [];
    }

    const qualifierCounts = new Map<string, number>();
    for (const source of sources) {
      const key = source.qualifier.toUpperCase();
      qualifierCounts.set(key, (qualifierCounts.get(key) ?? 0) + 1);
    }
    const uniqueSources = sources.filter((source) => {
      if (qualifierCounts.get(source.qualifier.toUpperCase()) !== 1) return false;
      return !localDefs.some((definition) =>
        definition.name.replace(/^"|"$/g, "").toUpperCase() === source.table.toUpperCase(),
      );
    });
    const currentJoin = uniqueSources[uniqueSources.length - 1];
    if (!currentJoin || currentJoin.kind !== "join") return [];

    const predicateTier = (sources: JoinTierSources): string => {
      const resolved = resolveJoinPredicateTier(sources);
      return resolved.ranked ? resolved.tier : "";
    };
    const relationDefaults = {
      database: effectiveDb,
      schema: effectiveSchema,
    };
    const relationIsBlocked = (
      previousSource: DirectJoinSource,
      currentSource: DirectJoinSource,
      pairs: ReadonlyArray<{ left: string; right: string }>,
    ): boolean => getRelationDecision(
      {
        database: previousSource.db ?? effectiveDb,
        schema: previousSource.schema ?? effectiveSchema,
        table: previousSource.table,
      },
      {
        database: currentSource.db ?? effectiveDb,
        schema: currentSource.schema ?? effectiveSchema,
        table: currentSource.table,
      },
      pairs.map((pair) => ({ left: pair.left, right: pair.right })),
      databaseKind,
      relationDefaults,
    ).decision === "blocked";
    const previousSourcesForScore = uniqueSources.slice(0, -1);
    const predicateScore = (
      relationKey: string | undefined,
      pairs: ReadonlyArray<{ left: string; right: string }>,
      previousSource: DirectJoinSource,
    ): number => relationRankingScore({
      relationKey,
      unscopedRelationKey: unscopedRelationKey(
        { database: previousSource.db, schema: previousSource.schema, table: previousSource.table },
        { database: currentJoin.db, schema: currentJoin.schema, table: currentJoin.table },
        pairs,
        databaseKind,
      ),
      pairs,
      source: previousSource,
      target: {
        database: currentJoin.db,
        schema: currentJoin.schema,
        table: currentJoin.table,
      },
      proximity: sourceProximity(previousSourcesForScore, previousSource),
      defaults: relationDefaults,
    });

    const configuredItems: CompletionItem[] = [];
    for (const previousSource of uniqueSources.slice(0, -1)) {
      const previousIdentity = {
        database: previousSource.db,
        schema: previousSource.schema,
        table: previousSource.table,
      };
      const currentIdentity = {
        database: currentJoin.db,
        schema: currentJoin.schema,
        table: currentJoin.table,
      };
      for (const relation of joinCompletionSettings.relations) {
        let pairs: Array<{ left: string; right: string }> | undefined;
        if (
          matchesJoinTableIdentity(relation.left, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.right, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.columns;
        } else if (
          matchesJoinTableIdentity(relation.right, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.left, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.columns.map((pair) => ({ left: pair.right, right: pair.left }));
        }
        if (!pairs) continue;
        if (relationIsBlocked(previousSource, currentJoin, pairs)) {
          continue;
        }
        const predicates = pairs.map((pair) =>
          `${formatDirectJoinQualifier(previousSource, databaseKind)}.${formatIdentifierForSql(pair.left, databaseKind)} = ${formatDirectJoinQualifier(currentJoin, databaseKind)}.${formatIdentifierForSql(pair.right, databaseKind)}`,
        );
        const text = predicates.join(" AND ");
        const relationKey = canonicalizeRelation({
          left: previousIdentity,
          right: currentIdentity,
          columns: pairs,
        }, databaseKind, { database: effectiveDb, schema: effectiveSchema })?.key;
        configuredItems.push({
          label: text,
          kind: CompletionItemKind.Reference,
          detail: "Join condition (configured relationship)",
          insertText: text,
          sortText: buildJoinSortText(
            predicateTier({ manual: true }),
            text,
            predicateScore(relationKey, pairs, previousSource),
          ),
          textEdit: { range: { start: position, end: position }, newText: text },
          data: {
            joinKnowledgeRelation: {
              left: previousIdentity,
              right: currentIdentity,
              columns: pairs.map((pair) => ({ left: pair.left, right: pair.right })),
              databaseKind,
              effectiveDatabase: effectiveDb,
              effectiveSchema,
            },
          },
        });
      }
    }

    // Confirmed predicates are emitted from the snapshot so they remain usable
    // without cached columns; configured relationships still win.
    const confirmedItems: CompletionItem[] = [];
    for (const relation of getConfirmedRelations()) {
      for (const previousSource of uniqueSources.slice(0, -1)) {
        const previousIdentity = {
          database: previousSource.db,
          schema: previousSource.schema,
          table: previousSource.table,
        };
        const currentIdentity = {
          database: currentJoin.db,
          schema: currentJoin.schema,
          table: currentJoin.table,
        };
        let pairs: Array<{ left: string; right: string }> | undefined;
        if (
          matchesJoinTableIdentity(relation.display.left, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.right, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns;
        } else if (
          matchesJoinTableIdentity(relation.display.right, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.left, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns.map((pair) => ({ left: pair.right, right: pair.left }));
        }
        if (!pairs) continue;
        const text = pairs.map((pair) =>
          `${formatDirectJoinQualifier(previousSource, databaseKind)}.${formatIdentifierForSql(pair.left, databaseKind)} = ${formatDirectJoinQualifier(currentJoin, databaseKind)}.${formatIdentifierForSql(pair.right, databaseKind)}`,
        ).join(" AND ");
        confirmedItems.push({
          label: text,
          kind: CompletionItemKind.Reference,
          detail: "Join condition (confirmed relationship)",
          insertText: text,
          sortText: buildJoinSortText(
            predicateTier({ confirmed: true }),
            text,
            predicateScore(relation.key, pairs, previousSource),
          ),
          textEdit: { range: { start: position, end: position }, newText: text },
          data: {
            joinKnowledgeRelation: {
              left: previousIdentity,
              right: currentIdentity,
              columns: pairs.map((pair) => ({ left: pair.left, right: pair.right })),
              databaseKind,
              effectiveDatabase: effectiveDb,
              effectiveSchema,
            },
          },
        });
      }
    }

    const favoriteItems: CompletionItem[] = [];
    for (const relation of getFavoriteRelations()) {
      for (const previousSource of uniqueSources.slice(0, -1)) {
        const previousIdentity = {
          database: previousSource.db,
          schema: previousSource.schema,
          table: previousSource.table,
        };
        const currentIdentity = {
          database: currentJoin.db,
          schema: currentJoin.schema,
          table: currentJoin.table,
        };
        let pairs: Array<{ left: string; right: string }> | undefined;
        if (
          matchesJoinTableIdentity(relation.display.left, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.right, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns;
        } else if (
          matchesJoinTableIdentity(relation.display.right, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.left, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns.map((pair) => ({ left: pair.right, right: pair.left }));
        }
        if (!pairs) continue;
        const text = pairs.map((pair) =>
          `${formatDirectJoinQualifier(previousSource, databaseKind)}.${formatIdentifierForSql(pair.left, databaseKind)} = ${formatDirectJoinQualifier(currentJoin, databaseKind)}.${formatIdentifierForSql(pair.right, databaseKind)}`,
        ).join(" AND ");
        favoriteItems.push({
          label: text,
          kind: CompletionItemKind.Reference,
          detail: "Join condition (favorite relationship)",
          insertText: text,
          sortText: buildJoinSortText(
            predicateTier({ favorite: true }),
            text,
            predicateScore(relation.key, pairs, previousSource),
          ),
          textEdit: { range: { start: position, end: position }, newText: text },
          data: {
            joinKnowledgeRelation: {
              left: previousIdentity,
              right: currentIdentity,
              columns: pairs.map((pair) => ({ left: pair.left, right: pair.right })),
              databaseKind,
              effectiveDatabase: effectiveDb,
              effectiveSchema,
            },
            joinKnowledgeFavorite: true,
          },
        });
      }
    }

    const workspaceItems: CompletionItem[] = [];
    for (const observed of getObservedRelations(databaseKind)) {
      const relation = observed.relation;
      const detail = `Join condition (${describeObservedSource(observed)}; ${observed.breadth})`;
      for (const previousSource of uniqueSources.slice(0, -1)) {
        const previousIdentity = {
          database: previousSource.db,
          schema: previousSource.schema,
          table: previousSource.table,
        };
        const currentIdentity = {
          database: currentJoin.db,
          schema: currentJoin.schema,
          table: currentJoin.table,
        };
        let pairs: Array<{ left: string; right: string }> | undefined;
        if (
          matchesJoinTableIdentity(relation.display.left, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.right, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns;
        } else if (
          matchesJoinTableIdentity(relation.display.right, previousIdentity, effectiveDb, effectiveSchema)
          && matchesJoinTableIdentity(relation.display.left, currentIdentity, effectiveDb, effectiveSchema)
        ) {
          pairs = relation.display.columns.map((pair) => ({ left: pair.right, right: pair.left }));
        }
        if (!pairs) continue;
        const text = pairs.map((pair) =>
          `${formatDirectJoinQualifier(previousSource, databaseKind)}.${formatIdentifierForSql(pair.left, databaseKind)} = ${formatDirectJoinQualifier(currentJoin, databaseKind)}.${formatIdentifierForSql(pair.right, databaseKind)}`,
        ).join(" AND ");
        workspaceItems.push({
          label: text,
          kind: CompletionItemKind.Reference,
          detail,
          insertText: text,
          sortText: buildJoinSortText(
            predicateTier(observedTierSources(observed)),
            text,
            predicateScore(relation.key, pairs, previousSource),
          ),
          textEdit: { range: { start: position, end: position }, newText: text },
          data: {
            joinKnowledgeRelation: {
              left: previousIdentity,
              right: currentIdentity,
              columns: pairs.map((pair) => ({ left: pair.left, right: pair.right })),
              databaseKind,
              effectiveDatabase: effectiveDb,
              effectiveSchema,
            },
          },
        });
      }
    }
    const columnsForSource = async (source: DirectJoinSource) => this.metadataResolver.getMetadataColumnsForSource(
      documentUri,
      source,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      this.buildMetadataColumnOptions(netezzaSchemasEnabled),
    );

    const previousJoinSources = uniqueSources.slice(0, -1);
    const joinSources = [currentJoin, ...previousJoinSources];
    const columnsBySource: MetadataColumnItem[][] = new Array(joinSources.length);
    let nextSourceIndex = 0;
    const loadNextSourceColumns = async (): Promise<void> => {
      while (nextSourceIndex < joinSources.length) {
        const sourceIndex = nextSourceIndex;
        nextSourceIndex += 1;
        columnsBySource[sourceIndex] = await columnsForSource(joinSources[sourceIndex]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(8, joinSources.length) },
        () => loadNextSourceColumns(),
      ),
    );
    const joinedColumns = columnsBySource[0] ?? [];
    const previousColumnsBySource = columnsBySource.slice(1);
    if (joinedColumns.length === 0) {
      const bestByText = new Map<string, CompletionItem>();
      for (const item of [
        ...configuredItems,
        ...confirmedItems,
        ...favoriteItems,
        ...workspaceItems,
      ]) {
        const key = String(item.insertText ?? item.label).toUpperCase();
        const existing = bestByText.get(key);
        if (!existing || String(item.sortText) < String(existing.sortText)) {
          bestByText.set(key, item);
        }
      }
      return [...bestByText.values()].sort((left, right) =>
        (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label),
      );
    }

    const declaredItems: CompletionItem[] = [];

    const matches: Array<{
      left: MetadataColumnItem;
      right: MetadataColumnItem;
      leftSource: DirectJoinSource;
      rightSource: DirectJoinSource;
      isKeyMatch: boolean;
    }> = [];
    for (const [previousIndex, previousSource] of previousJoinSources.entries()) {
      const previousColumns = previousColumnsBySource[previousIndex] ?? [];
      const previousIdentity = {
        database: previousSource.db ?? effectiveDb,
        schema: previousSource.schema ?? effectiveSchema,
        table: previousSource.table,
      };
      const currentIdentity = {
        database: currentJoin.db ?? effectiveDb,
        schema: currentJoin.schema ?? effectiveSchema,
        table: currentJoin.table,
      };
      const declaredGroups = new Map<string, Array<{ left: string; right: string; ordinal: number }>>();
      const addDeclaredPair = (constraintName: string | undefined, ordinal: number | undefined, left: string, right: string) => {
        const key = constraintName?.toUpperCase() || `COLUMN:${left.toUpperCase()}:${right.toUpperCase()}`;
        const pairs = declaredGroups.get(key) ?? [];
        if (!pairs.some((pair) => pair.left.toUpperCase() === left.toUpperCase() && pair.right.toUpperCase() === right.toUpperCase())) {
          pairs.push({ left, right, ordinal: ordinal ?? Number.MAX_SAFE_INTEGER });
          declaredGroups.set(key, pairs);
        }
      };
      for (const column of previousColumns) {
        for (const reference of column.joinReferences ?? []) {
          if (
            matchesJoinTableIdentity(
              { database: reference.toDatabase, schema: reference.toSchema, table: reference.toTable },
              currentIdentity,
              effectiveDb,
              effectiveSchema,
            )
          ) addDeclaredPair(reference.constraintName, reference.ordinalPosition, column.name, reference.toColumn);
        }
      }
      for (const column of joinedColumns) {
        for (const reference of column.joinReferences ?? []) {
          if (
            matchesJoinTableIdentity(
              { database: reference.toDatabase, schema: reference.toSchema, table: reference.toTable },
              previousIdentity,
              effectiveDb,
              effectiveSchema,
            )
          ) addDeclaredPair(reference.constraintName, reference.ordinalPosition, reference.toColumn, column.name);
        }
      }
      if (declaredGroups.size > 0) {
        for (const pairs of declaredGroups.values()) {
          pairs.sort((left, right) => left.ordinal - right.ordinal);
          const formattedPairs = pairs.map((pair) => ({ left: pair.left, right: pair.right }));
          if (relationIsBlocked(previousSource, currentJoin, formattedPairs)) {
            continue;
          }
          const predicates = pairs.map((pair) =>
            `${formatDirectJoinQualifier(previousSource, databaseKind)}.${formatIdentifierForSql(pair.left, databaseKind)} = ${formatDirectJoinQualifier(currentJoin, databaseKind)}.${formatIdentifierForSql(pair.right, databaseKind)}`,
          );
          const text = predicates.join(" AND ");
          const relationKey = canonicalizeRelation({
            left: previousIdentity,
            right: currentIdentity,
            columns: formattedPairs,
          }, databaseKind, { database: effectiveDb, schema: effectiveSchema })?.key;
          declaredItems.push({
            label: text,
            kind: CompletionItemKind.Reference,
            detail: "Join condition (declared foreign key)",
            insertText: text,
            sortText: buildJoinSortText(
              predicateTier({ catalogFk: true }),
              text,
              predicateScore(relationKey, formattedPairs, previousSource),
            ),
            textEdit: { range: { start: position, end: position }, newText: text },
            data: {
              joinKnowledgeRelation: {
                left: previousIdentity,
                right: currentIdentity,
                columns: formattedPairs,
                databaseKind,
                effectiveDatabase: effectiveDb,
                effectiveSchema,
              },
            },
          });
        }
        continue;
      }
      if (!joinCompletionSettings.nameHeuristicsEnabled) continue;
      const sourceMatches = findJoinColumnMatches(previousColumns, joinedColumns, {
        left: previousSource.table,
        right: currentJoin.table,
      });
      const normalizedCounts = new Map<string, number>();
      for (const column of previousColumns) {
        const normalized = normalizeRelationColumnName(column.name);
        normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
      }
      const joinedCounts = new Map<string, number>();
      for (const column of joinedColumns) {
        const normalized = normalizeRelationColumnName(column.name);
        joinedCounts.set(normalized, (joinedCounts.get(normalized) ?? 0) + 1);
      }
      for (const match of sourceMatches) {
        const normalized = normalizeRelationColumnName(match.left.name);
        if (!match.isKeyMatch && ((normalizedCounts.get(normalized) ?? 0) !== 1
          || (joinedCounts.get(normalized) ?? 0) !== 1)) {
          continue;
        }
        matches.push({ ...match, leftSource: previousSource, rightSource: currentJoin });
      }
    }

    const keyItems: CompletionItem[] = [];
    const heuristicItems: CompletionItem[] = [];
    for (const match of matches) {
      if (relationIsBlocked(match.leftSource, match.rightSource, [{
        left: match.left.name,
        right: match.right.name,
      }])) {
        continue;
      }
      const left = `${formatDirectJoinQualifier(match.leftSource, databaseKind)}.${formatIdentifierForSql(match.left.name, databaseKind)}`;
      const right = `${formatDirectJoinQualifier(match.rightSource, databaseKind)}.${formatIdentifierForSql(match.right.name, databaseKind)}`;
      const text = `${left} = ${right}`;
      const relationKey = canonicalizeRelation({
        left: {
          database: match.leftSource.db,
          schema: match.leftSource.schema,
          table: match.leftSource.table,
        },
        right: {
          database: match.rightSource.db,
          schema: match.rightSource.schema,
          table: match.rightSource.table,
        },
        columns: [{ left: match.left.name, right: match.right.name }],
      }, databaseKind, { database: effectiveDb, schema: effectiveSchema })?.key;
      const item: CompletionItem = {
        label: text,
        kind: CompletionItemKind.Reference,
        detail: match.isKeyMatch ? "Join condition (cached key/name match)" : "Join condition (name match)",
        insertText: text,
        // Join predicates outrank plain columns (2_) and local definitions (1_).
        sortText: buildJoinSortText(
          match.isKeyMatch
            ? predicateTier({ cachedKey: true })
            : predicateTier({ nameMatch: true }),
          text,
          predicateScore(
            relationKey,
            [{ left: match.left.name, right: match.right.name }],
            match.leftSource,
          ),
        ),
        textEdit: {
          range: { start: position, end: position },
          newText: text,
        },
        data: {
          joinKnowledgeRelation: {
            left: {
              database: match.leftSource.db,
              schema: match.leftSource.schema,
              table: match.leftSource.table,
            },
            right: {
              database: match.rightSource.db,
              schema: match.rightSource.schema,
              table: match.rightSource.table,
            },
            columns: [{ left: match.left.name, right: match.right.name }],
            databaseKind,
            effectiveDatabase: effectiveDb,
            effectiveSchema,
          },
        },
      };
      (match.isKeyMatch ? keyItems : heuristicItems).push(item);
    }
    const bestByText = new Map<string, CompletionItem>();
    for (const item of [
      ...configuredItems,
      ...confirmedItems,
      ...favoriteItems,
      ...workspaceItems,
      ...declaredItems,
      ...keyItems,
      ...heuristicItems,
    ]) {
      const key = String(item.insertText ?? item.label).toUpperCase();
      const existing = bestByText.get(key);
      if (!existing || String(item.sortText) < String(existing.sortText)) {
        bestByText.set(key, item);
      }
    }
    return [...bestByText.values()].sort((left, right) =>
      (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label),
    );
  }

  private extractDirectJoinSources(
    sql: string,
    databaseKind?: DatabaseKind,
  ): DirectJoinSource[] {
    const tokens = SqlLexer.tokenize(sql).tokens;
    const sources: DirectJoinSource[] = [];
    let nesting = 0;
    let foundFrom = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.image === "(") {
        nesting += 1;
        continue;
      }
      if (token.image === ")") {
        nesting = Math.max(0, nesting - 1);
        continue;
      }
      if (nesting !== 0) continue;
      // Comma joins and mixed comma/JOIN source lists are easy to mis-pair;
      // leave the normal column completions available without guessing here.
      if (foundFrom && token.image === ",") return [];

      const isFrom = token.tokenType.name === "From" && !foundFrom;
      const isJoin = token.tokenType.name === "Join";
      if (!isFrom && !isJoin) continue;
      if (isFrom) foundFrom = true;

      const parsed = parseQualifiedTableNameFromTokens(tokens, index + 1, databaseKind);
      if (!parsed) continue;
      const alias = this.parseAliasAfterTableRef(tokens, parsed.nextIndex);
      const qualifier = alias.alias || parsed.tableRef.table;
      sources.push({
        kind: isJoin ? "join" : "from",
        qualifier,
        qualifierQuoted: alias.alias ? alias.aliasQuoted : parsed.tableRef.tableQuoted,
        db: parsed.tableRef.database,
        schema: parsed.tableRef.schema,
        table: parsed.tableRef.table,
      });
      index = Math.max(index, alias.nextIndex - 1);
    }
    return sources;
  }

  private async buildUsingCommonColumnItems(
    statementPrefix: string,
    typedPrefix: string,
    position: Position,
    localDefs: LocalDefinition[],
    documentUri: string,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
    netezzaSchemasEnabled?: boolean,
  ): Promise<CompletionItem[] | undefined> {
    if (!/\bUSING\s*\([^()]*$/i.test(statementPrefix)) {
      return undefined;
    }
    // The USING clause belongs to the last join pair: the final FROM/JOIN
    // source plus the one before it.
    const sources = this.extractDirectJoinSources(statementPrefix, databaseKind);
    if (sources.length < 2) {
      return undefined;
    }
    const pair = sources.slice(-2);
    const columnsBySource: string[][] = [];
    for (const source of pair) {
      const localDefinition = findLocalDefinition(localDefs, source.table);
      if (localDefinition && localDefinition.columns.length > 0) {
        columnsBySource.push(localDefinition.columns.map((c) => stripQuotes(c.trim())).filter((c) => !!c && c !== "*"));
        continue;
      }
      const metadataColumns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        source,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        this.buildMetadataColumnOptions(netezzaSchemasEnabled),
      );
      columnsBySource.push(
        metadataColumns.map((c) => stripQuotes(c.name.trim())).filter((c) => !!c && c !== "*"),
      );
    }
    const [first, second] = columnsBySource;
    const secondKeys = new Set(second.map((c) => c.toUpperCase()));
    const seen = new Set<string>();
    const common: ScopedColumnCandidate[] = [];
    for (const column of first) {
      const key = column.toUpperCase();
      if (seen.has(key) || !secondKeys.has(key)) {
        continue;
      }
      seen.add(key);
      common.push({ column, qualifiers: [] });
    }
    return toScopedColumnItems(common, typedPrefix, position);
  }

  private async collectScopedColumns(
    scopeSources: ScopeSource[],
    localDefs: LocalDefinition[],
    documentUri: string,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
    netezzaSchemasEnabled?: boolean,
  ): Promise<ScopedColumnCandidate[]> {
    const columnsByName = new Map<
      string,
      { column: string; qualifiers: Set<string>; description?: string; usageBand?: number }
    >();

    for (const source of scopeSources) {
      const usageBands = this.columnUsageBandsFor(source, effectiveDb, effectiveSchema, databaseKind);
      let sourceColumns: { name: string; description?: string }[];
      const localDefinition = findLocalDefinition(localDefs, source.table);
      if (localDefinition && localDefinition.columns.length > 0) {
        sourceColumns = localDefinition.columns.map((c) => ({ name: c }));
      } else {
        const metadataColumns = await this.metadataResolver.getMetadataColumnsForSource(
          documentUri,
          source,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          this.buildMetadataColumnOptions(netezzaSchemasEnabled),
        );
        sourceColumns = metadataColumns
          .filter((column) => !!column.name)
          .map((column) => ({ name: column.name, description: column.description }));
      }

      for (const col of sourceColumns) {
        const cleanColumn = stripQuotes(col.name.trim());
        if (!cleanColumn || cleanColumn === "*" || cleanColumn.endsWith(".*")) {
          continue;
        }

        const key = cleanColumn.toUpperCase();
        const usageBand = usageBands?.get(key);
        const existing = columnsByName.get(key);
        if (!existing) {
          columnsByName.set(key, {
            column: cleanColumn,
            qualifiers: new Set([source.qualifier]),
            description: col.description,
            ...(usageBand !== undefined ? { usageBand } : {}),
          });
          continue;
        }
        existing.qualifiers.add(source.qualifier);
        if (usageBand !== undefined && (existing.usageBand === undefined || usageBand < existing.usageBand)) {
          existing.usageBand = usageBand;
        }
      }
    }

    return Array.from(columnsByName.values())
      .map((entry) => ({
        column: entry.column,
        qualifiers: Array.from(entry.qualifiers),
        description: entry.description,
        ...(entry.usageBand !== undefined ? { usageBand: entry.usageBand } : {}),
      }))
      .sort((a, b) => a.column.localeCompare(b.column));
  }

  private buildMetadataColumnOptions(
    netezzaSchemasEnabled?: boolean,
  ): { netezzaSchemasEnabled?: boolean } {
    return { netezzaSchemasEnabled };
  }

}
