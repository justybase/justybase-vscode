import {
  applyJoinKnowledgeImport,
  buildJoinKnowledgeExport,
  canonicalizeRelation,
  diffJoinKnowledgeImport,
  isWorkspaceEvidenceEligible,
  JoinKnowledgeStore,
  parseJoinKnowledgeImport,
  serializeJoinKnowledgeExport,
  type ApplyJoinKnowledgeImportOptions,
  type JoinKnowledgeExportDocument,
  type JoinKnowledgeImportDiff,
  type JoinKnowledgeImportResult,
  type JoinKnowledgeDiagnostics,
  type JoinKnowledgeSnapshot,
  type JoinKnowledgeState,
  type JoinRelationEvidenceRecord,
  type JoinRelationScoreOverride,
  type ObjectRef,
  type ObjectUsageKind,
  type RecordExecutedStatementOutcome,
  type RelationColumn,
  type RelationIdentity,
  type TableRef,
  type WorkspaceIndexSnapshot,
} from "@justybase/sql-core/joinKnowledge";

export interface ExecutedStatementCommandInput {
  /** Stable identity of one successful execution; repeats never add evidence. */
  executionKey: string;
  databaseKind?: string;
  relations: RelationIdentity[];
  objects: Array<{ object: ObjectRef; kind: ObjectUsageKind }>;
  /** Columns referenced through a resolved table binding (identifiers only). */
  columns?: Array<{ object: ObjectRef; column: string }>;
  /**
   * When the statement ran (ISO 8601). Defaults to now; history backfill
   * passes the original execution time so freshness and distinct days hold.
   */
  executedAt?: string;
}

export interface ExecutedStatementRecordResult {
  outcome: RecordExecutedStatementOutcome;
  /** `false` when the evidence was counted but the state write failed. */
  persisted: boolean;
  /** True when a retention limit stopped part of this event's evidence. */
  truncated?: boolean;
}

export interface JoinKnowledgePersistence {
  load(): Promise<JoinKnowledgeState>;
  save(state: JoinKnowledgeState): Promise<void>;
}

export interface JoinKnowledgeLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface JoinKnowledgeDisposable {
  dispose(): void;
}

export interface JoinRelationCommandInput {
  left: TableRef;
  right: TableRef;
  columns: RelationColumn[];
  databaseKind?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
}

export interface SqlObjectCommandInput {
  object: ObjectRef;
  databaseKind?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  band?: number;
  pinOrder?: number;
}

export type JoinKnowledgeImportPreview =
  | { ok: true; document: JoinKnowledgeExportDocument; diff: JoinKnowledgeImportDiff }
  | { ok: false; error: string };

export interface JoinKnowledgeServiceOptions {
  now?: () => string;
  logger?: JoinKnowledgeLogger;
}

/**
 * Owns Stage 1 manual knowledge in the extension host.
 *
 * Every mutation is persisted before listeners are notified, so the language
 * server never observes a decision that would disappear after restart.
 */
export class JoinKnowledgeService {
  private store = new JoinKnowledgeStore();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private initialized = false;
  /**
   * Manual decision lists before the last import of this session, plus the
   * decision count right after it. One-step undo only.
   */
  private lastImport: {
    before: Pick<JoinKnowledgeState, "relationOverrides" | "relationScoreOverrides" | "objectOverrides">;
    decisionSignatureAfter: string;
  } | undefined;

  constructor(
    private readonly persistence: JoinKnowledgePersistence,
    private readonly options: JoinKnowledgeServiceOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const state = await this.persistence.load();
      this.store = new JoinKnowledgeStore(state);
    } catch (error: unknown) {
      this.options.logger?.warn(
        `JOIN knowledge state could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.store = new JoinKnowledgeStore();
    }
  }

  getSnapshot(workspace?: WorkspaceIndexSnapshot): JoinKnowledgeSnapshot {
    const snapshot = this.store.buildSnapshot();
    const acceptedEvidence = this.store.getRelationEvidence()
      .filter((entry) => entry.source === "accepted");
    const workspaceWithAccepted = acceptedEvidence.length > 0
      ? this.mergeAcceptedEvidence(workspace, acceptedEvidence)
      : workspace;
    return {
      ...snapshot,
      ...(workspaceWithAccepted ? { workspace: workspaceWithAccepted } : {}),
    };
  }

  getDiagnostics(): JoinKnowledgeDiagnostics {
    return this.store.describe();
  }

  getObjectOverrides() {
    return this.store.getActiveObjectPreferences();
  }

  getRelationOverrides() {
    return this.store.getRelationOverrides();
  }

  getRelationScoreOverrides(): readonly JoinRelationScoreOverride[] {
    return this.store.getRelationScoreOverrides();
  }

  getRelationEvidence(): readonly JoinRelationEvidenceRecord[] {
    return this.store.getRelationEvidence();
  }

  onDidChange(listener: () => void): JoinKnowledgeDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async confirmRelation(input: JoinRelationCommandInput): Promise<string> {
    return this.appendRelation("confirm", input);
  }

  async blockRelation(input: JoinRelationCommandInput): Promise<string> {
    return this.appendRelation("block", input);
  }

  /**
   * Store a persistent "show this more often" preference. This is not a
   * confirmation: it ranks in `0_3_` below catalog FK and never promotes the
   * relation above a block.
   */
  async favoriteRelation(input: JoinRelationCommandInput): Promise<string> {
    return this.appendRelation("favorite", input);
  }

  /** Record an accepted JOIN completion as half-weight workspace evidence. */
  async recordAcceptedRelation(input: JoinRelationCommandInput): Promise<boolean> {
    const relation = canonicalizeRelation(
      {
        left: input.left,
        right: input.right,
        columns: input.columns,
      },
      input.databaseKind,
      {
        database: input.effectiveDatabase,
        schema: input.effectiveSchema,
      },
    );
    if (!relation) {
      throw new Error(
        "JOIN relation requires two different tables and at least one bound column pair.",
      );
    }
    const now = this.now();
    const existing = this.store.getRelationEvidence().find(
      (entry) => entry.relationKey === relation.key && entry.source === "accepted",
    );
    const day = now.slice(0, 10);
    const previousDay = existing?.lastSeenAt.slice(0, 10);
    const observations = (existing?.observations ?? 0) + 1;
    const weightedQueries = observations * 0.5;
    const databaseKind = input.databaseKind ?? existing?.databaseKind;
    this.store.upsertRelationEvidence({
      relationKey: relation.key,
      relation,
      ...(databaseKind ? { databaseKind } : {}),
      source: "accepted",
      observations,
      distinctDays: (existing?.distinctDays ?? 0) + (previousDay === day ? 0 : 1),
      distinctQueries: 0,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      belowThreshold: !isWorkspaceEvidenceEligible(0, 0, weightedQueries),
    });
    await this.persist(now);
    this.emit();
    return true;
  }

  /**
   * Count one successful statement execution as executed evidence (`0_4_`).
   *
   * `persisted: false` means the evidence is counted in memory but the write
   * failed; it is not reported as durable. The next successful save writes the
   * whole state, so the evidence is not lost unless the process exits first.
   */
  async recordExecutedStatement(input: ExecutedStatementCommandInput): Promise<ExecutedStatementRecordResult> {
    const [result] = await this.recordExecutedStatements([input]);
    return result;
  }

  /**
   * Record several executions with one state write and one change event
   * (history backfill). Results are in input order.
   */
  async recordExecutedStatements(
    inputs: readonly ExecutedStatementCommandInput[],
  ): Promise<ExecutedStatementRecordResult[]> {
    const now = this.now();
    const outcomes = inputs.map((input) => this.store.recordExecutedStatement({
      executionKey: input.executionKey,
      databaseKind: input.databaseKind,
      relations: input.relations,
      objects: input.objects,
      ...(input.columns ? { columns: input.columns } : {}),
      now: input.executedAt ?? now,
    }));
    const truncated = this.store.isExecutedTruncated();
    const recordedAny = outcomes.some((outcome) => outcome === "recorded");
    const persisted = recordedAny ? await this.persist(now) : true;
    if (recordedAny) {
      this.emit();
    }
    return outcomes.map((outcome) => ({
      outcome,
      persisted: outcome === "recorded" ? persisted : true,
      ...(truncated ? { truncated } : {}),
    }));
  }

  /** Oldest executed evidence time (ISO 8601), or `undefined` when there is none. */
  getEarliestExecutedAt(): string | undefined {
    return this.store.getEarliestExecutedAt();
  }

  /**
   * Remove executed evidence only. Manual decisions, score adjustments, accepted
   * evidence and workspace evidence stay as they are.
   */
  async clearExecutedEvidence(): Promise<{ relations: number; objects: number; columns: number }> {
    const removed = this.store.clearExecutedEvidence();
    if (removed.relations === 0 && removed.objects === 0 && removed.columns === 0) {
      return removed;
    }
    const now = this.now();
    await this.persist(now);
    this.emit();
    return removed;
  }

  /** Remove one executed relation record; manual and workspace evidence stay. */
  async deleteExecutedRelationEvidence(relationKey: string): Promise<boolean> {
    const removed = this.store.deleteExecutedRelationEvidence(relationKey);
    if (!removed) {
      return false;
    }
    const now = this.now();
    await this.persist(now);
    this.emit();
    return true;
  }

  /** Remove one executed object record; manual and workspace evidence stay. */
  async deleteExecutedObjectEvidence(objectKey: string): Promise<boolean> {
    const removed = this.store.deleteExecutedObjectEvidence(objectKey);
    if (!removed) {
      return false;
    }
    const now = this.now();
    await this.persist(now);
    this.emit();
    return true;
  }

  async deleteAcceptedRelationEvidence(relationKey: string): Promise<boolean> {
    const removed = this.store.removeRelationEvidence(relationKey, "accepted");
    if (!removed) {
      return false;
    }
    const now = this.now();
    await this.persist(now);
    this.emit();
    return true;
  }

  async setRelationScoreAdjustment(
    input: JoinRelationCommandInput,
    adjustment: number,
  ): Promise<string> {
    const now = this.now();
    const override = this.store.appendRelationScoreOverride({
      relation: { left: input.left, right: input.right, columns: input.columns },
      databaseKind: input.databaseKind,
      defaults: {
        database: input.effectiveDatabase,
        schema: input.effectiveSchema,
      },
      adjustment,
      now,
      id: this.nextId("score", now),
    });
    await this.persist(now);
    this.emit();
    return override.id;
  }

  /**
   * Remove the active within-tier score adjustment for a relation. Resetting
   * is a revert, not an appended zero, so the relation returns to its standard
   * ordering with no active score record.
   */
  async clearRelationScoreAdjustment(input: JoinRelationCommandInput): Promise<boolean> {
    const relation = canonicalizeRelation(
      {
        left: input.left,
        right: input.right,
        columns: input.columns,
      },
      input.databaseKind,
      {
        database: input.effectiveDatabase,
        schema: input.effectiveSchema,
      },
    );
    if (!relation) {
      throw new Error(
        "JOIN relation requires two different tables and at least one bound column pair.",
      );
    }
    const active = this.store.getRelationScoreOverrides().filter(
      (entry) => entry.relationKey === relation.key && !entry.revertedAt,
    );
    if (active.length === 0) {
      return false;
    }
    const now = this.now();
    for (const entry of active) {
      this.store.revertRelationScoreOverride(entry.id, now);
    }
    await this.persist(now);
    this.emit();
    return true;
  }

  async revertRelationScoreOverride(id: string): Promise<boolean> {
    const now = this.now();
    const reverted = this.store.revertRelationScoreOverride(id, now);
    if (!reverted) {
      return false;
    }
    await this.persist(now);
    this.emit();
    return true;
  }

  private mergeAcceptedEvidence(
    workspace: WorkspaceIndexSnapshot | undefined,
    evidence: readonly JoinRelationEvidenceRecord[],
  ): WorkspaceIndexSnapshot {
    const current = workspace ?? {
      version: 1 as const,
      relations: [],
      objects: [],
      truncated: false,
      generatedAt: this.now(),
    };
    const relations = new Map(current.relations.map((entry) => [entry.key, entry]));
    for (const accepted of evidence) {
      const previous = relations.get(accepted.relationKey);
      const acceptedSelections = accepted.observations;
      const distinctFiles = previous?.distinctFiles ?? 0;
      const distinctQueries = previous?.distinctQueries ?? 0;
      const weightedQueries = distinctQueries + acceptedSelections * 0.5;
      relations.set(accepted.relationKey, {
        key: accepted.relationKey,
        relation: previous?.relation ?? accepted.relation,
        observations: (previous?.observations ?? 0) + acceptedSelections,
        distinctFiles,
        distinctQueries,
        acceptedSelections,
        weightedQueries,
        belowThreshold: !isWorkspaceEvidenceEligible(
          distinctFiles,
          distinctQueries,
          weightedQueries,
        ),
        firstSeenAt: previous && previous.firstSeenAt < accepted.firstSeenAt
          ? previous.firstSeenAt
          : accepted.firstSeenAt,
        lastSeenAt: previous && previous.lastSeenAt > accepted.lastSeenAt
          ? previous.lastSeenAt
          : accepted.lastSeenAt,
      });
    }
    return {
      ...current,
      relations: [...relations.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
    };
  }

  async toggleFavoriteRelation(input: JoinRelationCommandInput): Promise<{
    favorited: boolean;
    blocked: boolean;
    confirmed: boolean;
    id?: string;
  }> {
    const defaults = {
      database: input.effectiveDatabase,
      schema: input.effectiveSchema,
    };
    const relation = canonicalizeRelation(
      {
        left: input.left,
        right: input.right,
        columns: input.columns,
      },
      input.databaseKind,
      defaults,
    );
    if (!relation) {
      throw new Error(
        "JOIN relation requires two different tables and at least one bound column pair.",
      );
    }
    const activeFavorite = this.store.getActiveFavorite(relation.key);
    if (activeFavorite) {
      await this.revertRelationOverride(activeFavorite.id);
      return {
        favorited: false,
        blocked: this.store.getRelationDecision(relation.key) === "blocked",
        confirmed: this.store.getRelationDecision(relation.key) === "confirmed",
      };
    }
    const id = await this.favoriteRelation(input);
    const decision = this.store.getRelationDecision(relation.key);
    return {
      favorited: true,
      blocked: decision === "blocked",
      confirmed: decision === "confirmed",
      id,
    };
  }

  private async appendRelation(
    kind: "confirm" | "block" | "favorite",
    input: JoinRelationCommandInput,
  ): Promise<string> {
    const defaults = {
      database: input.effectiveDatabase,
      schema: input.effectiveSchema,
    };
    const relation = canonicalizeRelation(
      {
        left: input.left,
        right: input.right,
        columns: input.columns,
      },
      input.databaseKind,
      defaults,
    );
    if (!relation) {
      throw new Error(
        "JOIN relation requires two different tables and at least one bound column pair.",
      );
    }
    const now = this.now();
    const override = this.store.appendRelationOverride({
      kind,
      relation: {
        left: input.left,
        right: input.right,
        columns: input.columns,
      },
      databaseKind: input.databaseKind,
      defaults,
      now,
      id: this.nextId("rel", now),
    });
    await this.persist(now);
    this.emit();
    return override.id;
  }

  async revertRelationOverride(id: string): Promise<boolean> {
    const now = this.now();
    const reverted = this.store.revertRelationOverride(id, now);
    if (!reverted) {
      return false;
    }
    await this.persist(now);
    this.emit();
    return true;
  }

  /**
   * Record one selected FROM completion as half-weight preference evidence.
   * It never creates a manual preference or a JOIN relation.
   */
  async recordAcceptedObject(input: SqlObjectCommandInput): Promise<boolean> {
    const now = this.now();
    const record = this.store.recordAcceptedObject({
      object: input.object,
      databaseKind: input.databaseKind,
      defaults: {
        database: input.effectiveDatabase,
        schema: input.effectiveSchema,
      },
      now,
    });
    if (!record) {
      return false;
    }
    await this.persist(now);
    this.emit();
    return true;
  }

  /** Remove accepted FROM selections for one object, or all of them. */
  async clearAcceptedObjectEvidence(objectKey?: string): Promise<number> {
    const removed = this.store.clearAcceptedObjectEvidence(objectKey);
    if (removed === 0) {
      return 0;
    }
    const now = this.now();
    await this.persist(now);
    this.emit();
    return removed;
  }

  async pinObject(input: SqlObjectCommandInput): Promise<string> {
    return this.appendObject("pin", input);
  }

  async boostObject(input: SqlObjectCommandInput): Promise<string> {
    return this.appendObject("boost", input);
  }

  async demoteObject(input: SqlObjectCommandInput): Promise<string> {
    return this.appendObject("demote", input);
  }

  async excludeObject(input: SqlObjectCommandInput): Promise<string> {
    return this.appendObject("exclude", input);
  }

  private async appendObject(
    kind: "pin" | "boost" | "demote" | "exclude",
    input: SqlObjectCommandInput,
  ): Promise<string> {
    const now = this.now();
    const pinOrder = kind === "pin"
      ? input.pinOrder ?? this.nextPinOrder()
      : undefined;
    const override = this.store.appendObjectPreference({
      kind,
      object: input.object,
      databaseKind: input.databaseKind,
      defaults: {
        database: input.effectiveDatabase,
        schema: input.effectiveSchema,
      },
      now,
      id: this.nextId("obj", now),
      band: kind === "boost" ? input.band : undefined,
      pinOrder,
    });
    await this.persist(now);
    this.emit();
    return override.id;
  }

  async revertObjectPreference(id: string): Promise<boolean> {
    const now = this.now();
    const reverted = this.store.revertObjectPreference(id, now);
    if (!reverted) {
      return false;
    }
    await this.persist(now);
    this.emit();
    return true;
  }

  private nextPinOrder(): number {
    const activePins = this.store
      .getActiveObjectPreferences()
      .filter((preference) => preference.kind === "pin");
    return activePins.reduce(
      (max, preference) => Math.max(max, preference.pinOrder ?? 0),
      0,
    ) + 1;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private nextId(prefix: string, now: string): string {
    this.sequence += 1;
    return `${prefix}-${now}-${this.sequence}`;
  }

  /** Returns `false` when the write failed; callers that report durability must check it. */
  /** Export active manual decisions only (no evidence, ids, history or salts). */
  exportKnowledge(): { text: string; document: JoinKnowledgeExportDocument } {
    const document = buildJoinKnowledgeExport(this.store, this.now());
    return { text: serializeJoinKnowledgeExport(document), document };
  }

  /** Validate the whole file and diff it against local decisions; no writes. */
  previewImport(text: string): JoinKnowledgeImportPreview {
    const parsed = parseJoinKnowledgeImport(text);
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      document: parsed.document,
      diff: diffJoinKnowledgeImport(this.store, parsed.document),
    };
  }

  /**
   * Apply a validated import as one transaction. A failed write restores the
   * previous in-memory state, so a failed import leaves nothing behind.
   */
  async importKnowledge(
    document: JoinKnowledgeExportDocument,
    options: Omit<ApplyJoinKnowledgeImportOptions, "now">,
  ): Promise<JoinKnowledgeImportResult> {
    const now = this.now();
    const before = this.store.getState();
    const result = applyJoinKnowledgeImport(this.store, document, { ...options, now });
    if (result.added === 0 && result.replaced === 0) {
      return result;
    }
    if (!(await this.persist(now))) {
      this.store = new JoinKnowledgeStore(before);
      throw new Error("JOIN knowledge import could not be saved; nothing was changed.");
    }
    this.lastImport = {
      before: {
        relationOverrides: before.relationOverrides,
        relationScoreOverrides: before.relationScoreOverrides ?? [],
        objectOverrides: before.objectOverrides,
      },
      decisionSignatureAfter: this.decisionSignature(),
    };
    this.emit();
    return result;
  }

  canUndoImport(): boolean {
    return this.lastImport !== undefined && this.lastImport.decisionSignatureAfter === this.decisionSignature();
  }

  /**
   * Undo the last import of this session: manual decisions return to their
   * pre-import lists, while evidence recorded since then is kept. Refused once
   * any manual decision changed after the import.
   */
  async undoLastImport(): Promise<boolean> {
    const lastImport = this.lastImport;
    if (!lastImport) {
      return false;
    }
    if (lastImport.decisionSignatureAfter !== this.decisionSignature()) {
      throw new Error("Manual JOIN knowledge decisions changed after the import; undo it item by item in the manager.");
    }
    const current = this.store.getState();
    this.store = new JoinKnowledgeStore({ ...current, ...lastImport.before });
    const now = this.now();
    if (!(await this.persist(now))) {
      this.store = new JoinKnowledgeStore(current);
      throw new Error("JOIN knowledge import undo could not be saved; the import is still active.");
    }
    this.lastImport = undefined;
    this.emit();
    return true;
  }

  /**
   * Signature of manual decision activity: appends change the record counts
   * and reverts change the reverted counts, so any manual change after an
   * import is detected.
   */
  private decisionSignature(): string {
    return [
      this.store.getRelationOverrides(),
      this.store.getRelationScoreOverrides(),
      this.store.getObjectOverrides(),
    ].map((list) => `${list.length}/${list.filter((entry) => entry.revertedAt).length}`).join(",");
  }

  private async persist(now: string): Promise<boolean> {
    try {
      await this.persistence.save(this.store.getState(now));
      return true;
    } catch (error: unknown) {
      this.options.logger?.warn(
        `JOIN knowledge state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
