/**
 * Offline JOIN ranking replay (leave-one-file-out).
 *
 * For every `JOIN` written in a workspace `.sql` file, the replay rebuilds the
 * workspace index from all *other* files, asks the real LSP completion engine
 * for JOIN targets at the position right after `JOIN `, and records where the
 * table the author actually wrote appears in the ranked list.
 *
 * It is a measurement tool for ranking changes (Top-1, Top-5, MRR), not a
 * runtime feature: it is never imported by the extension bundle and keeps all
 * SQL in memory. The reported cases contain identifiers only.
 */

import {
  CompletionItemKind,
  CompletionTriggerKind,
  type CompletionItem,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { IToken } from "chevrotain";
import {
  aggregateWorkspaceIndex,
  createWorkspaceIndexSnapshot,
  isConfidentJoinSuggestion,
  JOIN_GHOST_MODEL,
  type JoinGhostKind,
  JoinKnowledgeStore,
  type JoinKnowledgeSnapshot,
  type WorkspaceFileIndexRecord,
} from "@justybase/sql-core/joinKnowledge";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataObjectItem } from "../lsp/protocol";
import { DEFAULT_JOIN_COMPLETION_SETTINGS } from "../lsp/joinCompletionSettings";
import { SqlParser } from "../sql/sqlParser";
import { SqlLexer } from "../sqlParser";
import { LspCompletionEngine } from "../server/completionEngine";
import { isNumericAggregateArgumentAt } from "../server/completionExpressionAnalyzer";
import { computeJoinGhostSuggestion } from "../server/joinGhostSuggestion";
import { getCompletionMatchRank } from "../server/completionRanker";
import type { CompletionMetadataProvider } from "../server/completionTypes";
import {
  __TEST_ONLY_resetJoinKnowledge,
  setJoinKnowledgeSnapshot,
} from "../server/joinKnowledgeRanking";
import {
  createWorkspaceFingerprint,
  hashWorkspaceContent,
} from "./workspaceIndexEngine";
import { extractWorkspaceSql } from "./workspaceSqlExtractor";

export interface ReplayFile {
  relPath: string;
  text: string;
  /** File modification time; drives evidence freshness. */
  mtimeMs: number;
}

export type JoinRankingReplayMode = "target" | "predicate" | "column" | "object";

export interface JoinRankingReplayOptions {
  databaseKind?: DatabaseKind;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  /** Injected clock (ISO timestamp) used for index aggregation and freshness. */
  now: string;
  /** Upper bound on evaluated JOIN positions (default 5,000). */
  maxCases?: number;
  /**
   * Catalog metadata (tables, keys, cached JOIN targets). Without it the
   * replay measures workspace evidence alone.
   */
  metadataProvider?: CompletionMetadataProvider;
  /**
   * `target` (default) ranks JOIN targets after `JOIN `; `predicate` ranks
   * ON conditions after `JOIN t ON `; `column` ranks the column after a
   * table qualifier (`alias.`) in the complete statement; `object` ranks the
   * FROM source after `FROM `.
   */
  mode?: JoinRankingReplayMode;
  /**
   * `column`/`object` modes: characters of the expected name typed before
   * completion (default 0). Items that do not match them are filtered out,
   * as the editor does.
   */
  typed?: number;
  /**
   * `workspace` (default) rebuilds the leave-one-out workspace index;
   * `none` measures a cold start where only catalog metadata ranks targets;
   * `executed` counts every other file as one successful execution on its
   * own day (learning from executed queries, on by default).
   */
  evidence?: "workspace" | "none" | "executed";
  /**
   * Also index the statements before the evaluated one in the same file, as
   * the workspace index does for an open document (worksheet regime).
   */
  documentEvidence?: boolean;
}

export interface JoinRankingReplayCase {
  relPath: string;
  /** Upper-cased expected target table. */
  expected: string;
  /** 1-based rank of the first suggestion for the expected table, or undefined. */
  rank: number | undefined;
  /** Number of JOIN target suggestions offered. */
  candidates: number;
  /** Labels of the first five suggestions, for review of misses. */
  top: string[];
  /** Ranking tier of the expected suggestion (`0_1`, `0_5`, `2`, …). */
  tier?: string;
  /**
   * Reciprocal rank averaged over the suggestions sharing the expected
   * item's tier and score, so alphabetical tie order earns no credit.
   */
  tieAwareReciprocal?: number;
  /** `column` mode: clause of the reference (`select`, `where`, `on`, `group`, `order`, `having`). */
  clause?: string;
  /** `sortText` of the first two suggestions (ghost-text gate input). */
  leaders?: [string | undefined, string | undefined];
}

export interface JoinRankingReplayReport {
  files: number;
  cases: number;
  /** Cases where the expected table appeared anywhere in the list. */
  covered: number;
  top1: number;
  top3: number;
  top5: number;
  /** Mean reciprocal rank over all cases (a miss contributes 0). */
  mrr: number;
  /** MRR with ties (same tier and score) averaged instead of alphabetical. */
  tieAwareMrr: number;
  /** Expected suggestions per ranking tier. */
  tiers: Record<string, number>;
  details: JoinRankingReplayCase[];
}

const IDENTIFIER_IMAGE = /^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)$/u;

function unquote(image: string): string {
  return image.startsWith("\"") && image.endsWith("\"")
    ? image.slice(1, -1).replace(/""/g, "\"")
    : image.toUpperCase();
}

/** Qualified name parts after `JOIN` (`T`, `S.T`, `DB.S.T`, `DB..T`). */
function readTargetParts(tokens: readonly IToken[], start: number): string[] | undefined {
  const parts: string[] = [];
  let index = start;
  if (!IDENTIFIER_IMAGE.test(tokens[index]?.image ?? "")) {
    return undefined;
  }
  parts.push(unquote(tokens[index].image));
  index += 1;
  while (tokens[index]?.tokenType.name === "Dot") {
    while (tokens[index]?.tokenType.name === "Dot") {
      index += 1;
    }
    if (!IDENTIFIER_IMAGE.test(tokens[index]?.image ?? "")) {
      return undefined;
    }
    parts.push(unquote(tokens[index].image));
    index += 1;
  }
  return parts;
}

interface ReplayCaseInput {
  /** Document text; the cursor is at `offset`. */
  text: string;
  offset: number;
  /** Upper-cased table (target/object), column-pair set (predicate) or column (column mode). */
  expected: string;
  clause?: string;
  /** Offset of the case's statement in the file (document evidence). */
  statementStart?: number;
}

const prefixCase = (prefix: string, expected: string): ReplayCaseInput =>
  ({ text: prefix, offset: prefix.length, expected });

const CLAUSE_OF_TOKEN: Record<string, string> = {
  Select: "select", Where: "where", On: "on", GroupBy: "group", Group: "group",
  OrderBy: "order", Order: "order", Having: "having", From: "from", Join: "from",
};

/**
 * Clause of the token at `index`, from the nearest clause keyword at the same
 * paren depth; `aggregate` for the first token of a `SUM(`/`AVG(` argument.
 */
function clauseAt(tokens: readonly IToken[], index: number): string | undefined {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const name = tokens[cursor].tokenType.name;
    if (name === "RParen") depth += 1;
    else if (name === "LParen") {
      if (depth === 0) return isNumericAggregateArgumentAt(tokens, index) ? "aggregate" : undefined;
      depth -= 1;
    } else if (depth === 0 && CLAUSE_OF_TOKEN[name]) {
      return CLAUSE_OF_TOKEN[name];
    }
  }
  return undefined;
}

/** `FROM/JOIN/, table [AS] alias` bindings of a statement: alias (and bare table name) → table. */
function tableBindings(tokens: readonly IToken[]): Map<string, string> {
  const bindings = new Map<string, string>();
  tokens.forEach((token, index) => {
    const name = token.tokenType.name;
    if (name !== "From" && name !== "Join" && !(name === "Comma" && clauseAt(tokens, index) === "from")) {
      return;
    }
    const parts = readTargetParts(tokens, index + 1);
    if (!parts) {
      return;
    }
    const table = parts[parts.length - 1];
    let next = index + 2;
    while (tokens[next]?.tokenType.name === "Dot") {
      while (tokens[next]?.tokenType.name === "Dot") next += 1;
      next += 1;
    }
    if (tokens[next]?.tokenType.name === "As") next += 1;
    const alias = tokens[next];
    bindings.set(table, table);
    if (alias && alias.tokenType.name === "Identifier") {
      bindings.set(alias.image.toUpperCase(), table);
    }
  });
  return bindings;
}

function columnPairKey(left: string, right: string): string {
  return [left.toUpperCase(), right.toUpperCase()].sort().join("=");
}

/** Direction-free key of a set of column pairs: `A=B&C=D`. */
function columnSetKey(pairs: ReadonlyArray<{ left: string; right: string }>): string {
  return pairs.map((pair) => columnPairKey(pair.left, pair.right)).sort().join("&");
}

/** Column of `q.c` / `c` at `index`; returns the column and the next index. */
function readColumnReference(
  tokens: readonly IToken[],
  index: number,
): { column: string; next: number } | undefined {
  const parts = readTargetParts(tokens, index);
  if (!parts) {
    return undefined;
  }
  // One identifier per part; each separating run of dots (`DB..T`) is skipped.
  let next = index + 1;
  while (tokens[next]?.tokenType.name === "Dot") {
    while (tokens[next]?.tokenType.name === "Dot") {
      next += 1;
    }
    next += 1;
  }
  return { column: parts[parts.length - 1], next };
}

/** `a.x = b.y [AND c.z = d.w ...]` right after `ON`. */
function readEquiPredicate(tokens: readonly IToken[], start: number): string | undefined {
  const pairs: Array<{ left: string; right: string }> = [];
  let index = start;
  for (;;) {
    const left = readColumnReference(tokens, index);
    if (!left || tokens[left.next]?.image !== "=") {
      break;
    }
    const right = readColumnReference(tokens, left.next + 1);
    if (!right) {
      break;
    }
    pairs.push({ left: left.column, right: right.column });
    index = right.next;
    if (tokens[index]?.image.toUpperCase() !== "AND") {
      break;
    }
    index += 1;
  }
  return pairs.length > 0 ? columnSetKey(pairs) : undefined;
}

/** `alias.COLUMN` references bound to a FROM/JOIN table, cursor after the dot. */
function collectColumnCases(sql: string, typed: number): ReplayCaseInput[] {
  const tokens = SqlLexer.tokenize(sql).tokens;
  const bindings = tableBindings(tokens);
  const cases: ReplayCaseInput[] = [];
  tokens.forEach((token, index) => {
    const dot = tokens[index + 1];
    const column = tokens[index + 2];
    if (
      token.tokenType.name !== "Identifier"
      || dot?.tokenType.name !== "Dot"
      || column?.tokenType.name !== "Identifier"
      || tokens[index - 1]?.tokenType.name === "Dot"
      || tokens[index + 3]?.tokenType.name === "Dot"
      || !bindings.has(token.image.toUpperCase())
    ) {
      return;
    }
    const clause = clauseAt(tokens, index);
    if (!clause || clause === "from") {
      return;
    }
    const expected = column.image.toUpperCase();
    const typedText = column.image.slice(0, typed);
    const before = `${sql.slice(0, dot.startOffset + 1)}${typedText}`;
    cases.push({
      text: `${before}${sql.slice((column.endOffset ?? column.startOffset) + 1)}`,
      offset: before.length,
      expected,
      clause,
    });
  });
  return cases;
}

/** FROM sources that are plain tables, cursor after `FROM `. */
function collectObjectCases(sql: string, typed: number, objects: ReadonlySet<string>): ReplayCaseInput[] {
  const tokens = SqlLexer.tokenize(sql).tokens;
  const cases: ReplayCaseInput[] = [];
  tokens.forEach((token, index) => {
    if (token.tokenType.name !== "From") {
      return;
    }
    const parts = readTargetParts(tokens, index + 1);
    const expected = parts?.[parts.length - 1];
    if (!expected || !objects.has(expected)) {
      return;
    }
    const end = (token.endOffset ?? token.startOffset) + 1;
    cases.push(prefixCase(`${sql.slice(0, end)} ${expected.slice(0, typed)}`, expected));
  });
  return cases;
}

function collectCases(
  file: ReplayFile,
  databaseKind: DatabaseKind,
  fingerprint: (normalizedSql: string) => string,
  mode: JoinRankingReplayMode,
  typed: number,
): ReplayCaseInput[] {
  return SqlParser.splitStatementsWithPositions(file.text, databaseKind).flatMap((statement) =>
    collectStatementCases(statement.sql, databaseKind, fingerprint, mode, typed)
      .map((replayCase) => ({ ...replayCase, statementStart: statement.startOffset })));
}

function collectStatementCases(
  sql: string,
  databaseKind: DatabaseKind,
  fingerprint: (normalizedSql: string) => string,
  mode: JoinRankingReplayMode,
  typed: number,
): ReplayCaseInput[] {
  const cases: ReplayCaseInput[] = [];
  if (mode === "column") {
    return collectColumnCases(sql, typed);
  }
  if (mode === "object") {
    const extraction = extractWorkspaceSql(sql, { databaseKind, fingerprint });
    const objects = new Set(extraction.objects.map((entry) => entry.object.name.toUpperCase()));
    return collectObjectCases(sql, typed, objects);
  }
  if (!/\bJOIN\b/i.test(sql)) {
    return cases;
  }
  // Only JOINs the extractor accepts are evaluable; CTE/derived/USING/OR
  // joins carry no evidence and would only measure parser coverage.
  const extraction = extractWorkspaceSql(sql, { databaseKind, fingerprint });
  const tablesInRelations = new Set<string>();
  for (const contribution of extraction.relations) {
    for (const table of contribution.relation.tables) {
      tablesInRelations.add(table.table.toUpperCase());
    }
  }
  if (tablesInRelations.size === 0) {
    return cases;
  }
  const tokens = SqlLexer.tokenize(sql).tokens;
  tokens.forEach((token, index) => {
    if (token.tokenType.name !== "Join") {
      return;
    }
    const parts = readTargetParts(tokens, index + 1);
    if (!parts) {
      return;
    }
    const expected = parts[parts.length - 1].toUpperCase();
    if (!tablesInRelations.has(expected)) {
      return;
    }
    if (mode === "target") {
      const end = (token.endOffset ?? token.startOffset) + 1;
      cases.push(prefixCase(`${sql.slice(0, end)} `, expected));
      return;
    }
    const onIndex = tokens.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.image.toUpperCase() === "ON");
    const nextJoin = tokens.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.tokenType.name === "Join");
    if (onIndex < 0 || (nextJoin >= 0 && nextJoin < onIndex)) {
      return;
    }
    const predicate = readEquiPredicate(tokens, onIndex + 1);
    if (!predicate) {
      return;
    }
    const end = (tokens[onIndex].endOffset ?? tokens[onIndex].startOffset) + 1;
    cases.push(prefixCase(`${sql.slice(0, end)} `, predicate));
  });
  return cases;
}

/** Executed evidence from every file but one: each file is one execution on its own day. */
function executedSnapshotExcept(
  records: readonly WorkspaceFileIndexRecord[],
  excluded: number,
  databaseKind: DatabaseKind,
  now: string,
): JoinKnowledgeSnapshot {
  const store = new JoinKnowledgeStore();
  const nowMs = Date.parse(now);
  records.forEach((record, index) => {
    if (index === excluded) {
      return;
    }
    store.recordExecutedStatement({
      executionKey: `replay:${index}`,
      databaseKind,
      relations: record.relations.map((entry) => entry.relation),
      objects: record.objects.map((entry) => ({ object: entry.object, kind: entry.kind })),
      columns: (record.columns ?? []).map((entry) => ({ object: entry.object, column: entry.column })),
      now: new Date(nowMs - (index % 60) * 86_400_000).toISOString(),
    });
  });
  return store.buildSnapshot();
}

class ReplayMetadataProvider implements CompletionMetadataProvider {
  constructor(
    private readonly databaseKind: DatabaseKind,
    private readonly effectiveDatabase: string | undefined,
    private readonly effectiveSchema: string | undefined,
  ) {}

  async getContext(): Promise<Awaited<ReturnType<CompletionMetadataProvider["getContext"]>>> {
    return {
      effectiveDatabase: this.effectiveDatabase,
      effectiveSchema: this.effectiveSchema,
      databaseKind: this.databaseKind,
      joinCompletionSettings: DEFAULT_JOIN_COMPLETION_SETTINGS,
    };
  }

  async getDatabases(): Promise<MetadataObjectItem[]> { return []; }
  async getSchemas(): Promise<MetadataObjectItem[]> { return []; }
  async getTables(): Promise<MetadataObjectItem[]> { return []; }
  async getViews(): Promise<MetadataObjectItem[]> { return []; }
  async getProcedures(): Promise<MetadataObjectItem[]> { return []; }
  async getColumns(): Promise<[]> { return []; }
  async getCachedJoinTargets(): Promise<MetadataObjectItem[]> { return []; }
}

/** `0_1_25_X` → `0_1`; `2_40_X` → `2`. */
function sortTier(sortText: string | undefined): string | undefined {
  const match = /^(0_\d|\d)_/u.exec(sortText ?? "");
  return match?.[1];
}

/** Tier and score part of a JOIN sortText (`0_2_35_`), without the label. */
function sortRankKey(sortText: string | undefined): string {
  return /^(?:0_\d_|\d_)(?:\d\d_)?/u.exec(sortText ?? "")?.[0] ?? "";
}

function tieAwareReciprocal(
  ranked: CompletionItem[],
  position: number,
  tieKey: (item: CompletionItem) => string,
): number {
  const key = tieKey(ranked[position]);
  let first = position;
  let last = position;
  while (first > 0 && tieKey(ranked[first - 1]) === key) first -= 1;
  while (last < ranked.length - 1 && tieKey(ranked[last + 1]) === key) last += 1;
  let total = 0;
  for (let rank = first + 1; rank <= last + 1; rank += 1) total += 1 / rank;
  return total / (last - first + 1);
}

function targetTable(item: CompletionItem): string | undefined {
  const data = item.data as { joinKnowledgeRelation?: { right?: { table?: string } } } | undefined;
  return data?.joinKnowledgeRelation?.right?.table?.toUpperCase();
}

function columnName(item: CompletionItem): string | undefined {
  return item.kind === CompletionItemKind.Field ? item.label.toUpperCase() : undefined;
}

function objectName(item: CompletionItem): string | undefined {
  if (item.kind !== CompletionItemKind.Class && item.kind !== CompletionItemKind.Interface) {
    return undefined;
  }
  const parts = item.label.split(".");
  return unquote(parts[parts.length - 1]);
}

/**
 * Column/object sort keys end with the name; the rest is the tie group.
 * JOIN sort keys use their tier and score.
 */
function tieKeyOf(mode: JoinRankingReplayMode): (item: CompletionItem) => string {
  if (mode === "target" || mode === "predicate") {
    return (item) => sortRankKey(item.sortText);
  }
  return (item) => {
    const sortText = item.sortText ?? "";
    const cut = sortText.toUpperCase().lastIndexOf(item.label.toUpperCase());
    return cut > 0 ? sortText.slice(0, cut) : sortText;
  };
}

function predicateColumns(item: CompletionItem): string | undefined {
  const data = item.data as {
    joinKnowledgeRelation?: { columns?: Array<{ left: string; right: string }> };
  } | undefined;
  const columns = data?.joinKnowledgeRelation?.columns;
  return columns?.length ? columnSetKey(columns) : undefined;
}

/**
 * Run the leave-one-file-out replay. The module-level LSP knowledge state is
 * reset before returning, so callers can run it inside a test process.
 */
export async function runJoinRankingReplay(
  files: readonly ReplayFile[],
  options: JoinRankingReplayOptions,
): Promise<JoinRankingReplayReport> {
  const databaseKind = options.databaseKind ?? "netezza";
  const fingerprint = createWorkspaceFingerprint("join-ranking-replay");
  const indexRecord = (relPath: string, text: string, mtimeMs: number, open: boolean): WorkspaceFileIndexRecord => {
    const extraction = extractWorkspaceSql(text, { databaseKind, fingerprint });
    return {
      relPath,
      size: Buffer.byteLength(text, "utf8"),
      mtimeMs,
      contentHash: hashWorkspaceContent(text),
      dirty: false,
      open,
      fingerprints: [...new Set(extraction.fingerprints)].sort(),
      relations: extraction.relations,
      objects: extraction.objects,
      columns: extraction.columns,
      skipped: extraction.skipped,
    };
  };
  const records = files.map((file) => indexRecord(file.relPath, file.text, file.mtimeMs, false));

  const engine = new LspCompletionEngine(
    options.metadataProvider
      ?? new ReplayMetadataProvider(databaseKind, options.effectiveDatabase, options.effectiveSchema),
  );
  const useWorkspace = (options.evidence ?? "workspace") === "workspace";
  const mode = options.mode ?? "target";
  const keyOf = { target: targetTable, predicate: predicateColumns, column: columnName, object: objectName }[mode];
  const tieKey = tieKeyOf(mode);
  const typed = mode === "column" || mode === "object" ? Math.max(0, options.typed ?? 0) : 0;
  const maxCases = options.maxCases ?? 5_000;
  const details: JoinRankingReplayCase[] = [];
  try {
    for (const [fileIndex, file] of files.entries()) {
      if (details.length >= maxCases) {
        break;
      }
      const cases = collectCases(file, databaseKind, fingerprint, mode, typed);
      if (cases.length === 0) {
        continue;
      }
      const others = useWorkspace ? records.filter((_, index) => index !== fileIndex) : [];
      const applyEvidence = (statementStart: number): void => {
        if (options.evidence === "executed") {
          setJoinKnowledgeSnapshot(
            executedSnapshotExcept(records, fileIndex, databaseKind, options.now),
            { now: options.now },
          );
          return;
        }
        const document = options.documentEvidence && statementStart > 0
          ? [indexRecord(`${file.relPath}#document`, file.text.slice(0, statementStart), file.mtimeMs, true)]
          : [];
        const aggregate = aggregateWorkspaceIndex([...others, ...document], { now: options.now });
        setJoinKnowledgeSnapshot({
          version: 1,
          relations: [],
          objectPreferences: [],
          workspace: createWorkspaceIndexSnapshot(aggregate, {
            generatedAt: options.now,
            truncated: false,
          }),
        }, { now: options.now });
      };
      let appliedStart: number | undefined;
      for (const replayCase of cases) {
        if (details.length >= maxCases) {
          break;
        }
        const statementStart = options.documentEvidence ? replayCase.statementStart ?? 0 : 0;
        if (statementStart !== appliedStart) {
          applyEvidence(statementStart);
          appliedStart = statementStart;
        }
        const document = TextDocument.create(
          `file:///replay/${encodeURIComponent(file.relPath)}`,
          "sql",
          1,
          replayCase.text,
        );
        const items = await engine.provideCompletionItems(
          document,
          document.positionAt(replayCase.offset),
          typed > 0 ? CompletionTriggerKind.Invoked : CompletionTriggerKind.TriggerCharacter,
        );
        const typedText = replayCase.expected.slice(0, typed);
        // VS Code orders by its filter score (approximated by the match rank:
        // prefix before word/acronym/fragment matches), then sortText, then label.
        const matchRank = (item: CompletionItem): number =>
          typedText ? getCompletionMatchRank(keyOf(item) ?? "", typedText) ?? 9 : 0;
        const ranked = items
          .filter((item) => keyOf(item) !== undefined && matchRank(item) < 9)
          .sort((left, right) =>
            matchRank(left) - matchRank(right)
            || (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label)
            || left.label.localeCompare(right.label));
        const position = ranked.findIndex((item) => keyOf(item) === replayCase.expected);
        details.push({
          relPath: file.relPath,
          expected: replayCase.expected,
          rank: position >= 0 ? position + 1 : undefined,
          candidates: ranked.length,
          top: ranked.slice(0, 5).map((item) => keyOf(item) ?? item.label),
          leaders: [ranked[0]?.sortText, ranked[1]?.sortText],
          ...(replayCase.clause ? { clause: replayCase.clause } : {}),
          ...(position >= 0
            ? {
              tier: sortTier(ranked[position].sortText),
              tieAwareReciprocal: tieAwareReciprocal(ranked, position, tieKey),
            }
            : {}),
        });
      }
    }
  } finally {
    __TEST_ONLY_resetJoinKnowledge();
  }

  return { files: files.length, ...summarizeJoinRankingCases(details) };
}

/** Aggregate metrics for a set of replayed cases (all, or one area). */
export function summarizeJoinRankingCases(
  details: JoinRankingReplayCase[],
): Omit<JoinRankingReplayReport, "files"> {
  const within = (k: number): number =>
    details.filter((entry) => entry.rank !== undefined && entry.rank <= k).length;
  const mrr = details.length === 0
    ? 0
    : details.reduce((total, entry) => total + (entry.rank ? 1 / entry.rank : 0), 0) / details.length;
  const tieAwareMrr = details.length === 0
    ? 0
    : details.reduce((total, entry) => total + (entry.tieAwareReciprocal ?? 0), 0) / details.length;
  const tiers: Record<string, number> = {};
  for (const entry of details) {
    const tier = entry.rank === undefined ? "miss" : entry.tier ?? "?";
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  }
  return {
    cases: details.length,
    covered: details.filter((entry) => entry.rank !== undefined).length,
    top1: within(1),
    top3: within(3),
    top5: within(5),
    mrr,
    tieAwareMrr,
    tiers,
    details,
  };
}

export interface JoinGhostReplaySummary {
  cases: number;
  /** Positions where the gate would show ghost text. */
  shown: number;
  /** Shown ghosts whose target is the table the author wrote. */
  correct: number;
  /** correct / shown (1 when nothing is shown). */
  precision: number;
  /** correct / cases. */
  coverage: number;
}

/** How often a confident top suggestion would be right (`isConfidentJoinSuggestion`). */
export function summarizeJoinGhost(
  details: readonly JoinRankingReplayCase[],
  kind: JoinGhostKind,
  model: typeof JOIN_GHOST_MODEL = JOIN_GHOST_MODEL,
): JoinGhostReplaySummary {
  const shown = details.filter((entry) =>
    isConfidentJoinSuggestion(kind, entry.leaders?.[0], entry.leaders?.[1], model));
  const correct = shown.filter((entry) => entry.rank === 1).length;
  return {
    cases: details.length,
    shown: shown.length,
    correct,
    precision: shown.length === 0 ? 1 : correct / shown.length,
    coverage: details.length === 0 ? 0 : correct / details.length,
  };
}

/** Per-area rows (first path segment) when the corpus spans several areas. */
function formatAreas(report: JoinRankingReplayReport): string[] {
  const areas = new Map<string, JoinRankingReplayCase[]>();
  for (const entry of report.details) {
    const area = entry.relPath.split("/")[0];
    areas.set(area, [...(areas.get(area) ?? []), entry]);
  }
  if (areas.size < 2) {
    return [];
  }
  const rows = [...areas.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([area, entries]) => {
      const summary = summarizeJoinRankingCases(entries);
      const pct = (value: number): string => `${((value / summary.cases) * 100).toFixed(1)}%`;
      return `| ${area} | ${summary.cases} | ${pct(summary.covered)} | ${pct(summary.top1)} | `
        + `${pct(summary.top3)} | ${summary.mrr.toFixed(3)} | ${summary.tieAwareMrr.toFixed(3)} |`;
    });
  return [
    "| Area | Cases | Covered | Top-1 | Top-3 | MRR | MRR, ties averaged |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ];
}

/** Markdown summary; identifiers and counters only. */
export function formatJoinRankingReplayReport(
  report: JoinRankingReplayReport,
  title = "JOIN ranking replay",
  maxMisses = 25,
): string {
  const pct = (value: number): string =>
    report.cases === 0 ? "n/a" : `${((value / report.cases) * 100).toFixed(1)}%`;
  const misses = report.details
    .filter((entry) => entry.rank === undefined || entry.rank > 1)
    .slice(0, maxMisses);
  return [
    `# ${title}`,
    "",
    `Files: ${report.files}, evaluated JOIN positions: ${report.cases}`,
    "",
    "| Metric | Result |",
    "|---|---|",
    `| Covered (expected target offered) | ${report.covered} (${pct(report.covered)}) |`,
    `| Top-1 | ${report.top1} (${pct(report.top1)}) |`,
    `| Top-3 | ${report.top3} (${pct(report.top3)}) |`,
    `| Top-5 | ${report.top5} (${pct(report.top5)}) |`,
    `| MRR | ${report.mrr.toFixed(3)} |`,
    `| MRR, ties averaged | ${report.tieAwareMrr.toFixed(3)} |`,
    "",
    `Tier of the expected suggestion: ${Object.entries(report.tiers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tier, count]) => `${tier}=${count}`)
      .join(", ")}`,
    "",
    ...formatAreas(report),
    "## First misses (expected not ranked first)",
    "",
    "| File | Expected | Rank | Candidates | Top 5 |",
    "|---|---|---|---|---|",
    ...misses.map((entry) =>
      `| ${entry.relPath} | ${entry.expected} | ${entry.rank ?? "-"} | ${entry.candidates} | ${entry.top.join(", ")} |`),
    "",
  ].join("\n");
}

export interface GroupByGhostReplayReport {
  /** `GROUP BY` positions in the corpus. */
  positions: number;
  /** Positions where a ghost was offered. */
  shown: number;
  /** Shown ghosts equal to the written list (same expressions, same order). */
  exact: number;
  /** Shown ghosts with the same expressions in another order. */
  sameSet: number;
  /** Shown / exact matches over all positions (precision uses `exact + sameSet`). */
  precision: number;
  coverage: number;
}

const GROUP_BY_END = new Set([
  "Having", "Order", "OrderBy", "Limit", "Union", "Intersect", "Except", "Minus", "Qualify", "Window", "Semicolon",
]);

function normalizeGroupItem(text: string): string {
  return text.replace(/\s+/gu, "").toUpperCase();
}

/** Written `GROUP BY` items starting at `start`, split on top-level commas. */
function writtenGroupByItems(sql: string, tokens: readonly IToken[], start: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let itemStart = tokens[start]?.startOffset;
  let end = sql.length;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    const name = token.tokenType.name;
    if (name === "LParen") depth += 1;
    else if (name === "RParen") {
      if (depth === 0) { end = token.startOffset; break; }
      depth -= 1;
    } else if (depth === 0 && GROUP_BY_END.has(name)) {
      end = token.startOffset;
      break;
    } else if (depth === 0 && name === "Comma") {
      items.push(sql.slice(itemStart, token.startOffset));
      itemStart = tokens[index + 1]?.startOffset;
    }
  }
  if (itemStart !== undefined && itemStart < end) {
    items.push(sql.slice(itemStart, end));
  }
  return items.map(normalizeGroupItem).filter(Boolean);
}

/**
 * Replays every `GROUP BY` of the corpus: the ghost at `GROUP BY ` against
 * the list the author wrote. No knowledge or catalog is involved.
 */
export function runGroupByGhostReplay(
  files: readonly ReplayFile[],
  detect: (textBefore: string, textAfter: string) => string | undefined,
  databaseKind: DatabaseKind = "netezza",
): GroupByGhostReplayReport {
  let positions = 0;
  let shown = 0;
  let exact = 0;
  let sameSet = 0;
  for (const file of files) {
    for (const statement of SqlParser.splitStatementsWithPositions(file.text, databaseKind)) {
      const tokens = SqlLexer.tokenize(statement.sql).tokens;
      tokens.forEach((token, index) => {
        const name = token.tokenType.name;
        const isGroupBy = name === "GroupBy" || (name === "Group" && tokens[index + 1]?.tokenType.name === "By");
        if (!isGroupBy) {
          return;
        }
        const listStart = name === "GroupBy" ? index + 1 : index + 2;
        const keywordEnd = tokens[listStart - 1];
        positions += 1;
        const before = `${statement.sql.slice(0, keywordEnd.startOffset + keywordEnd.image.length)} `;
        const ghost = detect(before, "");
        if (!ghost) {
          return;
        }
        shown += 1;
        const written = writtenGroupByItems(statement.sql, tokens, listStart);
        const offered = ghost.split(",").map(normalizeGroupItem);
        if (offered.join(",") === written.join(",")) {
          exact += 1;
        } else if (offered.length === written.length && offered.every((item) => written.includes(item))) {
          sameSet += 1;
        }
      });
    }
  }
  return {
    positions,
    shown,
    exact,
    sameSet,
    precision: shown === 0 ? 0 : (exact + sameSet) / shown,
    coverage: positions === 0 ? 0 : (exact + sameSet) / positions,
  };
}

export interface KeystrokeSummary {
  cases: number;
  /** Characters of the expected text, typed in full without completion. */
  withoutCompletion: number;
  /** Keystrokes with completion: typed characters, arrow presses and the accept key. */
  withCompletion: number;
  /** 1 − withCompletion / withoutCompletion. */
  savedRatio: number;
}

/**
 * Keystrokes saved by completion (JetBrains-style "saved keystrokes"), from
 * replays of the same corpus with different numbers of typed characters.
 *
 * For each position the cheapest way is taken: type `k` characters, press
 * Down `rank − 1` times and accept (`k + rank`), or type the whole expected
 * text. With `ghost`, a correct confident ghost at `typed: 0` costs one `Tab`.
 * The expected text is the key the replay compares: table, column or the
 * normalized ON columns (the ON/alias text inserted with a JOIN target is not
 * counted, so savings are understated there).
 */
export function summarizeKeystrokes(
  runs: ReadonlyArray<{ typed: number; report: JoinRankingReplayReport }>,
  options: { ghost?: JoinGhostKind } = {},
): KeystrokeSummary {
  const [first] = runs;
  if (!first) {
    return { cases: 0, withoutCompletion: 0, withCompletion: 0, savedRatio: 0 };
  }
  for (const run of runs) {
    const aligned = run.report.details.length === first.report.details.length
      && run.report.details.every((entry, index) => entry.expected === first.report.details[index].expected);
    if (!aligned) {
      throw new Error("Keystroke runs must replay the same cases.");
    }
  }
  let withoutCompletion = 0;
  let withCompletion = 0;
  first.report.details.forEach((_, index) => {
    const expectedLength = first.report.details[index].expected.length;
    let cost = expectedLength;
    for (const { typed, report } of runs) {
      const entry = report.details[index];
      if (entry.rank !== undefined) {
        cost = Math.min(cost, typed + entry.rank);
      }
      if (options.ghost && typed === 0 && entry.rank === 1
        && isConfidentJoinSuggestion(options.ghost, entry.leaders?.[0], entry.leaders?.[1])) {
        cost = Math.min(cost, 1);
      }
    }
    withoutCompletion += expectedLength;
    withCompletion += cost;
  });
  return {
    cases: first.report.details.length,
    withoutCompletion,
    withCompletion,
    savedRatio: withoutCompletion === 0 ? 0 : 1 - withCompletion / withoutCompletion,
  };
}

export interface NewLineJoinGhostReport {
  /** Ends of a top-level SELECT FROM clause: before a JOIN, a later clause or the end. */
  positions: number;
  /** Of those, positions where the author wrote another JOIN next. */
  joinPositions: number;
  shown: number;
  /** Shown ghosts joining the table the author joined next. */
  correct: number;
  /** correct / shown (1 when nothing is shown). */
  precision: number;
  /** correct / joinPositions. */
  coverage: number;
}

const NEW_LINE_JOIN_START = new Set(["Join", "Left", "Right", "Inner", "Full", "Cross", "Natural"]);
const NEW_LINE_CLAUSE_END = new Set([
  "Where", "GroupBy", "Group", "Having", "OrderBy", "Order", "Limit", "Union", "Intersect", "Except", "Minus",
]);

/**
 * Replays the `afterJoinAndNewLine` ghost: at the end of every top-level
 * SELECT FROM clause the cursor is put on a new empty line (nothing after it,
 * as while typing) and the ghost is compared with what the author wrote next.
 * A ghost before `WHERE`/`GROUP BY`/the end is a wrong guess.
 */
export async function runNewLineJoinGhostReplay(
  files: readonly ReplayFile[],
  options: Omit<JoinRankingReplayOptions, "mode" | "typed" | "documentEvidence">,
): Promise<NewLineJoinGhostReport> {
  const databaseKind = options.databaseKind ?? "netezza";
  const fingerprint = createWorkspaceFingerprint("join-ranking-replay");
  const records = files.map((file) => {
    const extraction = extractWorkspaceSql(file.text, { databaseKind, fingerprint });
    return {
      relPath: file.relPath,
      size: Buffer.byteLength(file.text, "utf8"),
      mtimeMs: file.mtimeMs,
      contentHash: hashWorkspaceContent(file.text),
      dirty: false,
      open: false,
      fingerprints: [...new Set(extraction.fingerprints)].sort(),
      relations: extraction.relations,
      objects: extraction.objects,
      columns: extraction.columns,
      skipped: extraction.skipped,
    } satisfies WorkspaceFileIndexRecord;
  });
  const engine = new LspCompletionEngine(
    options.metadataProvider
      ?? new ReplayMetadataProvider(databaseKind, options.effectiveDatabase, options.effectiveSchema),
  );
  const report = { positions: 0, joinPositions: 0, shown: 0, correct: 0 };
  try {
    for (const [fileIndex, file] of files.entries()) {
      if (options.evidence === "executed") {
        setJoinKnowledgeSnapshot(executedSnapshotExcept(records, fileIndex, databaseKind, options.now), { now: options.now });
      } else {
        const others = options.evidence === "none" ? [] : records.filter((_, index) => index !== fileIndex);
        setJoinKnowledgeSnapshot({
          version: 1,
          relations: [],
          objectPreferences: [],
          workspace: createWorkspaceIndexSnapshot(aggregateWorkspaceIndex(others, { now: options.now }), {
            generatedAt: options.now,
            truncated: false,
          }),
        }, { now: options.now });
      }
      for (const statement of SqlParser.splitStatementsWithPositions(file.text, databaseKind)) {
        for (const { offset, nextTarget } of fromClauseEnds(statement.sql)) {
          report.positions += 1;
          if (nextTarget) {
            report.joinPositions += 1;
          }
          const text = `${statement.sql.slice(0, offset).trimEnd()}\n`;
          const document = TextDocument.create(`file:///replay/${encodeURIComponent(file.relPath)}`, "sql", 1, text);
          const ghost = await computeJoinGhostSuggestion(engine, document, document.positionAt(text.length), "afterJoinAndNewLine");
          if (!ghost) {
            continue;
          }
          report.shown += 1;
          const offered = /^JOIN\s+(\S+)/iu.exec(ghost.insertText)?.[1].split(".").pop()?.replace(/"/gu, "").toUpperCase();
          if (nextTarget && offered === nextTarget) {
            report.correct += 1;
          }
        }
      }
    }
  } finally {
    __TEST_ONLY_resetJoinKnowledge();
  }
  return {
    ...report,
    precision: report.shown === 0 ? 1 : report.correct / report.shown,
    coverage: report.joinPositions === 0 ? 0 : report.correct / report.joinPositions,
  };
}

/** Offsets where the FROM clause of a top-level SELECT may end, with the table joined next (if any). */
function fromClauseEnds(sql: string): Array<{ offset: number; nextTarget?: string }> {
  const tokens = SqlLexer.tokenize(sql).tokens;
  const first = tokens[0]?.tokenType.name;
  if (first !== "Select" && first !== "With") {
    return [];
  }
  const ends: Array<{ offset: number; nextTarget?: string }> = [];
  let depth = 0;
  let inFrom = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index].tokenType.name;
    if (name === "LParen") { depth += 1; continue; }
    if (name === "RParen") { depth -= 1; continue; }
    if (depth !== 0) continue;
    if (name === "From") { inFrom = true; continue; }
    if (!inFrom) continue;
    const startsJoin = NEW_LINE_JOIN_START.has(name)
      && !NEW_LINE_JOIN_START.has(tokens[index - 1]?.tokenType.name ?? "");
    if (startsJoin) {
      let joinIndex = index;
      while (tokens[joinIndex] && tokens[joinIndex].tokenType.name !== "Join") joinIndex += 1;
      const parts = readTargetParts(tokens, joinIndex + 1);
      ends.push({ offset: tokens[index].startOffset, nextTarget: parts?.[parts.length - 1].toUpperCase() });
      continue;
    }
    if (NEW_LINE_CLAUSE_END.has(name) || name === "Semicolon") {
      ends.push({ offset: tokens[index].startOffset });
      inFrom = false;
    }
  }
  if (inFrom) {
    ends.push({ offset: sql.length });
  }
  return ends;
}
