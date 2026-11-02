/**
 * Incremental workspace SQL index engine.
 *
 * The engine owns per-file records and aggregates them through the shared
 * `@justybase/sql-core/joinKnowledge` model. It is intentionally independent
 * of VS Code: selection, Git and watchers live in the coordinator, so the
 * consistency gate can be tested deterministically with real files and a
 * counting parser.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  aggregateWorkspaceIndex,
  createWorkspaceIndexSnapshot,
  diffWorkspaceIndex,
  normalizeObjectRef,
  objectRefKey,
  summarizeWorkspaceIndex,
  verifyRelationIdentity,
  type JoinKnowledgeIndexDelta,
  type WorkspaceFileIndexRecord,
  type WorkspaceIndexAggregate,
  type WorkspaceIndexSnapshot,
  type WorkspaceIndexStats,
  type WorkspaceSkipReason,
} from "@justybase/sql-core/joinKnowledge";
import type { DatabaseKind } from "../contracts/database";
import {
  extractWorkspaceSql,
  type WorkspaceSqlExtraction,
} from "./workspaceSqlExtractor";

export type WorkspaceIndexGitMode = "window" | "all" | "unavailable";

export interface WorkspaceIndexPersistedState {
  version: 1;
  salt: string;
  files: WorkspaceFileIndexRecord[];
  head?: string;
  truncated: boolean;
  gitMode?: WorkspaceIndexGitMode;
  savedAt?: string;
}

export interface WorkspaceFileInput {
  relPath: string;
  size: number;
  mtimeMs: number;
  dirty: boolean;
  open: boolean;
  /** Precomputed for dirty/open documents; disk files may omit it. */
  contentHash?: string;
  /** Lazily read text; not called for an unchanged cached file. */
  loadText?: () => Promise<string> | string;
}

export interface WorkspaceIndexEngineOptions {
  databaseKind?: DatabaseKind;
  salt?: string;
  now?: () => string;
  checkpointEvery?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxStatementsPerFile?: number;
  onCheckpoint?: (
    state: WorkspaceIndexPersistedState,
  ) => Promise<void> | void;
  onProgress?: (progress: {
    indexed: number;
    total: number;
    relPath: string;
  }) => void;
  isCancelled?: () => boolean;
}

export interface WorkspaceIndexReconcileResult {
  reindexed: string[];
  reused: string[];
  removed: string[];
  cancelled: boolean;
}

export interface WorkspaceIndexMutation {
  delta: JoinKnowledgeIndexDelta;
  record?: WorkspaceFileIndexRecord;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2000;

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function createFingerprint(salt: string): (normalizedSql: string) => string {
  return (normalizedSql: string): string => {
    return createHash("sha256")
      .update(salt, "utf8")
      .update("\u0000", "utf8")
      .update(normalizedSql, "utf8")
      .digest("hex")
      .slice(0, 32);
  };
}

function normalizeSalt(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{16,128}$/u.test(value)
    ? value
    : randomBytes(16).toString("hex");
}

function emptyState(): WorkspaceIndexPersistedState {
  return {
    version: 1,
    salt: randomBytes(16).toString("hex"),
    files: [],
    truncated: false,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSkipped(
  value: unknown,
): Partial<Record<WorkspaceSkipReason, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Partial<Record<WorkspaceSkipReason, number>> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!Number.isFinite(count) || (count as number) <= 0) {
      continue;
    }
    result[key as WorkspaceSkipReason] = Math.round(count as number);
  }
  return result;
}

/**
 * Parse a persisted index defensively. A malformed file record is dropped and
 * will be re-indexed; no SQL text can be injected because the type has no field
 * for it.
 */
export function parseWorkspaceIndexState(
  value: unknown,
  databaseKind?: DatabaseKind,
): WorkspaceIndexPersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyState();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return emptyState();
  }
  const files: WorkspaceFileIndexRecord[] = [];
  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const file = entry as Record<string, unknown>;
      const relPath = asString(file.relPath);
      const contentHash = asString(file.contentHash);
      const size = asNumber(file.size);
      const mtimeMs = asNumber(file.mtimeMs);
      if (!relPath || !contentHash || size === undefined || mtimeMs === undefined) {
        continue;
      }
      const fingerprints = Array.isArray(file.fingerprints)
        ? file.fingerprints.filter(
            (fingerprint): fingerprint is string =>
              typeof fingerprint === "string" && /^[0-9a-f]{16,64}$/u.test(fingerprint),
          )
        : [];
      const relations: WorkspaceFileIndexRecord["relations"] = [];
      if (Array.isArray(file.relations)) {
        for (const relationEntry of file.relations) {
          if (!relationEntry || typeof relationEntry !== "object" || Array.isArray(relationEntry)) {
            continue;
          }
          const contribution = relationEntry as Record<string, unknown>;
          const fingerprint = asString(contribution.fingerprint);
          const relation = contribution.relation;
          if (!fingerprint || !relation || typeof relation !== "object") {
            continue;
          }
          const verified = verifyRelationIdentity(
            relation as WorkspaceFileIndexRecord["relations"][number]["relation"],
            databaseKind,
          );
          if (!verified) {
            continue;
          }
          relations.push({ relation: verified, fingerprint });
        }
      }
      const objects: WorkspaceFileIndexRecord["objects"] = [];
      if (Array.isArray(file.objects)) {
        for (const objectEntry of file.objects) {
          if (!objectEntry || typeof objectEntry !== "object" || Array.isArray(objectEntry)) {
            continue;
          }
          const contribution = objectEntry as Record<string, unknown>;
          const fingerprint = asString(contribution.fingerprint);
          const kind = contribution.kind;
          const confidence = contribution.confidence;
          const object = contribution.object;
          if (
            !fingerprint
            || (kind !== "select" && kind !== "insert" && kind !== "update" && kind !== "delete")
            || (confidence !== "exact" && confidence !== "probable")
            || !object
            || typeof object !== "object"
          ) {
            continue;
          }
          const objectRecord = object as Record<string, unknown>;
          const name = asString(objectRecord.name);
          if (!name) {
            continue;
          }
          const normalizedObject = normalizeObjectRef({
            name,
            ...(asString(objectRecord.database) ? { database: asString(objectRecord.database)! } : {}),
            ...(asString(objectRecord.schema) ? { schema: asString(objectRecord.schema)! } : {}),
          }, databaseKind);
          if (!normalizedObject) {
            continue;
          }
          objects.push({
            object: normalizedObject,
            kind,
            fingerprint,
            confidence,
          });
        }
      }
      // A record persisted before column ranking has no `columns` field; it
      // stays `undefined` so the next reconcile re-parses that file once.
      let columns: WorkspaceFileIndexRecord["columns"];
      if (Array.isArray(file.columns)) {
        columns = [];
        for (const columnEntry of file.columns) {
          if (!columnEntry || typeof columnEntry !== "object" || Array.isArray(columnEntry)) {
            continue;
          }
          const contribution = columnEntry as Record<string, unknown>;
          const fingerprint = asString(contribution.fingerprint);
          const column = asString(contribution.column);
          const object = contribution.object;
          if (!fingerprint || !column || !object || typeof object !== "object" || Array.isArray(object)) {
            continue;
          }
          const objectRecord = object as Record<string, unknown>;
          const normalizedObject = normalizeObjectRef({
            name: asString(objectRecord.name) ?? "",
            ...(asString(objectRecord.database) ? { database: asString(objectRecord.database)! } : {}),
            ...(asString(objectRecord.schema) ? { schema: asString(objectRecord.schema)! } : {}),
          }, databaseKind);
          if (!normalizedObject) {
            continue;
          }
          columns.push({ object: normalizedObject, column, fingerprint });
        }
      }
      files.push({
        relPath,
        size,
        mtimeMs,
        contentHash,
        dirty: file.dirty === true,
        open: file.open === true,
        fingerprints,
        relations,
        objects,
        ...(columns ? { columns } : {}),
        skipped: parseSkipped(file.skipped),
      });
    }
  }
  return {
    version: 1,
    salt: normalizeSalt(record.salt),
    files,
    ...(asString(record.head) ? { head: asString(record.head)! } : {}),
    truncated: record.truncated === true,
    ...(record.gitMode === "window" || record.gitMode === "all" || record.gitMode === "unavailable"
      ? { gitMode: record.gitMode }
      : {}),
    ...(asString(record.savedAt) ? { savedAt: asString(record.savedAt)! } : {}),
  };
}

export class WorkspaceIndexEngine {
  private readonly files = new Map<string, WorkspaceFileIndexRecord>();
  private fingerprint: (normalizedSql: string) => string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;
  private readonly maxStatementsPerFile: number;
  private cachedAggregate: WorkspaceIndexAggregate | undefined;
  private checkpointCounter = 0;
  private salt: string;
  private head: string | undefined;
  private truncated: boolean;
  private gitMode: WorkspaceIndexGitMode | undefined;

  constructor(private readonly options: WorkspaceIndexEngineOptions = {}) {
    this.salt = normalizeSalt(options.salt);
    this.fingerprint = createFingerprint(this.salt);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxStatementsPerFile = options.maxStatementsPerFile ?? 2000;
    this.truncated = false;
  }

  public load(state: WorkspaceIndexPersistedState): void {
    this.files.clear();
    for (const file of state.files) {
      this.files.set(file.relPath, file);
    }
    this.salt = state.salt;
    // The persisted salt is authoritative after a restart. Rebuild the hasher
    // so new statements dedupe against the fingerprints already on disk.
    this.fingerprint = createFingerprint(this.salt);
    this.head = state.head;
    this.truncated = state.truncated;
    this.gitMode = state.gitMode;
    this.cachedAggregate = undefined;
  }

  public getSalt(): string {
    return this.salt;
  }

  public getHead(): string | undefined {
    return this.head;
  }

  public setGitState(options: {
    head?: string;
    truncated?: boolean;
    gitMode?: WorkspaceIndexGitMode;
  }): void {
    if (options.head !== undefined) {
      this.head = options.head;
    }
    if (options.truncated !== undefined) {
      this.truncated = options.truncated;
    }
    if (options.gitMode !== undefined) {
      this.gitMode = options.gitMode;
    }
  }

  public getPersistedState(savedAt?: string): WorkspaceIndexPersistedState {
    return {
      version: 1,
      salt: this.salt,
      files: [...this.files.values()]
        .sort((left, right) => left.relPath.localeCompare(right.relPath, "en"))
        .map((file) => ({
          ...file,
          fingerprints: [...new Set(file.fingerprints)].sort(),
          relations: [...file.relations].sort((left, right) =>
            `${left.relation.key}\u0000${left.fingerprint}`.localeCompare(
              `${right.relation.key}\u0000${right.fingerprint}`,
              "en",
            ),
          ),
          objects: [...file.objects].sort((left, right) =>
            `${left.object.database ?? ""}\u0000${left.object.schema ?? ""}\u0000${left.object.name}\u0000${left.kind}\u0000${left.fingerprint}`
              .localeCompare(
                `${right.object.database ?? ""}\u0000${right.object.schema ?? ""}\u0000${right.object.name}\u0000${right.kind}\u0000${right.fingerprint}`,
                "en",
              ),
          ),
        })),
      ...(this.head ? { head: this.head } : {}),
      truncated: this.truncated,
      ...(this.gitMode ? { gitMode: this.gitMode } : {}),
      ...(savedAt ? { savedAt } : {}),
    };
  }

  public getAggregate(): WorkspaceIndexAggregate {
    if (!this.cachedAggregate) {
      this.cachedAggregate = aggregateWorkspaceIndex(
        [...this.files.values()],
        { now: this.now() },
      );
    }
    return this.cachedAggregate;
  }

  public getSnapshot(): WorkspaceIndexSnapshot {
    return createWorkspaceIndexSnapshot(this.getAggregate(), {
      generatedAt: this.now(),
      truncated: this.truncated,
    });
  }

  public getStats(): WorkspaceIndexStats {
    return summarizeWorkspaceIndex([...this.files.values()], this.getAggregate());
  }

  public getFileCount(): number {
    return this.files.size;
  }

  public getTotalBytes(): number {
    let total = 0;
    for (const file of this.files.values()) {
      total += file.size;
    }
    return total;
  }

  public hasFile(relPath: string): boolean {
    return this.files.has(relPath);
  }

  /** Full reconcile: reuse unchanged records, parse changed files, drop stale ones. */
  public async reconcile(
    inputs: readonly WorkspaceFileInput[],
    options: {
      head?: string;
      truncated?: boolean;
      gitMode?: WorkspaceIndexGitMode;
    } = {},
  ): Promise<WorkspaceIndexReconcileResult> {
    this.truncated = options.truncated === true;
    const selected = new Set(inputs.map((input) => input.relPath));
    const removed: string[] = [];
    for (const relPath of [...this.files.keys()]) {
      if (!selected.has(relPath)) {
        this.files.delete(relPath);
        removed.push(relPath);
      }
    }
    const reindexed: string[] = [];
    const reused: string[] = [];
    const processed = new Set<string>();
    let totalBytes = 0;
    let fileCount = 0;
    const sorted = [...inputs].sort((left, right) =>
      left.relPath.localeCompare(right.relPath, "en"),
    );
    for (let index = 0; index < sorted.length; index += 1) {
      if (this.options.isCancelled?.()) {
        await this.checkpoint();
        this.cachedAggregate = undefined;
        return { reindexed, reused, removed, cancelled: true };
      }
      const input = sorted[index];
      fileCount += 1;
      if (fileCount > this.maxFiles || totalBytes + input.size > this.maxTotalBytes) {
        this.truncated = true;
        break;
      }
      if (input.size > this.maxFileBytes) {
        this.truncated = true;
        this.files.delete(input.relPath);
        processed.add(input.relPath);
        continue;
      }
      totalBytes += input.size;
      processed.add(input.relPath);
      this.options.onProgress?.({
        indexed: index + 1,
        total: sorted.length,
        relPath: input.relPath,
      });
      const cached = this.files.get(input.relPath);
      if (
        cached
        && cached.size === input.size
        && cached.mtimeMs === input.mtimeMs
        && cached.dirty === input.dirty
        && (input.contentHash === undefined || cached.contentHash === input.contentHash)
        // Records from before column ranking are re-parsed once.
        && cached.columns !== undefined
      ) {
        reused.push(input.relPath);
        continue;
      }
      const record = await this.parseInput(input);
      if (!record) {
        this.files.delete(input.relPath);
        continue;
      }
      this.files.set(input.relPath, record);
      reindexed.push(input.relPath);
      await this.checkpointMaybe();
    }
    // Files not reached because of a cap must not keep stale evidence.
    for (const relPath of selected) {
      if (!processed.has(relPath)) {
        this.files.delete(relPath);
      }
    }
    if (options.head !== undefined) {
      this.head = options.head;
    }
    if (options.truncated !== undefined) {
      this.truncated = this.truncated || options.truncated;
    }
    if (options.gitMode !== undefined) {
      this.gitMode = options.gitMode;
    }
    await this.checkpoint();
    this.cachedAggregate = undefined;
    // The coordinator publishes a full snapshot after reconcile; incremental
    // single-file changes use `indexFile`/`removeFile` affected-key deltas.
    return { reindexed, reused, removed, cancelled: false };
  }

  /** Index one changed file and return the affected-key delta. */
  public async indexFile(input: WorkspaceFileInput): Promise<WorkspaceIndexMutation> {
    const previous = this.getAggregate();
    const existingSize = this.files.get(input.relPath)?.size ?? 0;
    const overCap = this.files.size >= this.maxFiles && !this.files.has(input.relPath)
      || this.getTotalBytes() - existingSize + input.size > this.maxTotalBytes;
    if (input.size > this.maxFileBytes || overCap) {
      this.files.delete(input.relPath);
      this.truncated = true;
      this.cachedAggregate = undefined;
      await this.checkpoint();
      return {
        delta: diffWorkspaceIndex(previous, this.getAggregate(), {
          generatedAt: this.now(),
          truncated: true,
        }),
      };
    }
    const record = await this.parseInput(input);
    if (!record) {
      this.files.delete(input.relPath);
    } else {
      this.files.set(input.relPath, record);
    }
    this.cachedAggregate = undefined;
    await this.checkpoint();
    return {
      delta: diffWorkspaceIndex(previous, this.getAggregate(), {
        generatedAt: this.now(),
        truncated: this.truncated,
      }),
      ...(record ? { record } : {}),
    };
  }

  /**
   * Remove every workspace contribution for one canonical relation.
   * Observed evidence only: manual overrides are a different store and are
   * never touched here. A later edit that still contains the relation can
   * legitimately re-observe it.
   */
  public async deleteRelationEvidence(
    relationKey: string,
  ): Promise<JoinKnowledgeIndexDelta> {
    const previous = this.getAggregate();
    for (const record of this.files.values()) {
      record.relations = record.relations.filter(
        (entry) => entry.relation.key !== relationKey,
      );
    }
    this.cachedAggregate = undefined;
    await this.checkpoint();
    return diffWorkspaceIndex(previous, this.getAggregate(), {
      generatedAt: this.now(),
      truncated: this.truncated,
    });
  }

  /** Remove every workspace usage contribution for one FROM object. */
  public async deleteObjectEvidence(
    objectKey: string,
  ): Promise<JoinKnowledgeIndexDelta> {
    const previous = this.getAggregate();
    for (const record of this.files.values()) {
      record.objects = record.objects.filter(
        (entry) => objectRefKey(entry.object) !== objectKey,
      );
    }
    this.cachedAggregate = undefined;
    await this.checkpoint();
    return diffWorkspaceIndex(previous, this.getAggregate(), {
      generatedAt: this.now(),
      truncated: this.truncated,
    });
  }

  public async removeFile(relPath: string): Promise<JoinKnowledgeIndexDelta> {
    const previous = this.getAggregate();
    this.files.delete(relPath);
    this.cachedAggregate = undefined;
    await this.checkpoint();
    return diffWorkspaceIndex(previous, this.getAggregate(), {
      generatedAt: this.now(),
      truncated: this.truncated,
    });
  }

  public async clear(options: { keepSalt?: boolean } = {}): Promise<void> {
    this.files.clear();
    this.cachedAggregate = undefined;
    this.truncated = false;
    if (options.keepSalt !== true) {
      this.salt = randomBytes(16).toString("hex");
      this.fingerprint = createFingerprint(this.salt);
    }
    await this.checkpoint();
  }

  public async checkpoint(): Promise<void> {
    this.checkpointCounter = 0;
    await this.options.onCheckpoint?.(this.getPersistedState(this.now()));
  }

  private async checkpointMaybe(): Promise<void> {
    this.checkpointCounter += 1;
    const every = Math.max(1, this.options.checkpointEvery ?? 25);
    if (this.checkpointCounter >= every) {
      await this.checkpoint();
    }
  }

  private async parseInput(
    input: WorkspaceFileInput,
  ): Promise<WorkspaceFileIndexRecord | undefined> {
    if (!input.loadText) {
      return undefined;
    }
    const text = await input.loadText();
    const extraction: WorkspaceSqlExtraction = extractWorkspaceSql(text, {
      databaseKind: this.options.databaseKind,
      fingerprint: this.fingerprint,
      maxStatements: this.maxStatementsPerFile,
    });
    return {
      relPath: input.relPath,
      size: input.size,
      mtimeMs: input.mtimeMs,
      contentHash: input.contentHash ?? hashContent(text),
      dirty: input.dirty,
      open: input.open,
      fingerprints: [...new Set(extraction.fingerprints)].sort(),
      relations: extraction.relations.sort((left, right) =>
        `${left.relation.key}\u0000${left.fingerprint}`.localeCompare(
          `${right.relation.key}\u0000${right.fingerprint}`,
          "en",
        ),
      ),
      objects: extraction.objects.sort((left, right) =>
        `${left.object.database ?? ""}\u0000${left.object.schema ?? ""}\u0000${left.object.name}\u0000${left.kind}\u0000${left.fingerprint}`
          .localeCompare(
            `${right.object.database ?? ""}\u0000${right.object.schema ?? ""}\u0000${right.object.name}\u0000${right.kind}\u0000${right.fingerprint}`,
            "en",
          ),
      ),
      columns: extraction.columns.sort((left, right) =>
        `${left.object.database ?? ""}\u0000${left.object.schema ?? ""}\u0000${left.object.name}\u0000${left.column}\u0000${left.fingerprint}`
          .localeCompare(
            `${right.object.database ?? ""}\u0000${right.object.schema ?? ""}\u0000${right.object.name}\u0000${right.column}\u0000${right.fingerprint}`,
            "en",
          )),
      skipped: extraction.skipped,
    };
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

/** Exported for tests that need a stable content hash. */
export function hashWorkspaceContent(text: string): string {
  return hashContent(text);
}

/** Exported for tests that need a deterministic fingerprint function. */
export function createWorkspaceFingerprint(salt: string): (normalizedSql: string) => string {
  return createFingerprint(salt);
}
