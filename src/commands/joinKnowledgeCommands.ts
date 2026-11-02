import * as vscode from "vscode";
import { formatJoinGhostStats, type JoinGhostStatsSnapshot } from "../knowledge/joinGhostStats";
import {
  canonicalizeRelation,
  type JoinKnowledgeDiagnostics,
  type ObjectRef,
  type RelationColumn,
  type TableRef,
} from "@justybase/sql-core/joinKnowledge";
import type {
  HistoryBackfillResult,
  JoinKnowledgeExecutionCounters,
} from "../knowledge/joinKnowledgeExecution";
import { getJoinKnowledgeExecutionCapture } from "../knowledge/joinKnowledgeRuntime";
import type {
  JoinKnowledgeService,
  JoinRelationCommandInput,
  SqlObjectCommandInput,
} from "../knowledge/joinKnowledgeService";
import type { WorkspaceIndexStatus } from "../knowledge/workspaceIndexCoordinator";
import { registerJoinKnowledgePortabilityCommands } from "./joinKnowledgePortabilityCommands";
import type { JoinKnowledgeSuggestionItem } from "../lsp/protocol";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`JOIN knowledge: ${field} must be a non-empty identifier.`);
  }
  return value.trim();
}

function readTableRef(value: unknown, field: string): TableRef {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`JOIN knowledge: ${field} must be an object with a table name.`);
  }
  return {
    table: asIdentifier(record.table, `${field}.table`),
    ...(typeof record.database === "string" && record.database.trim()
      ? { database: record.database.trim() }
      : {}),
    ...(typeof record.schema === "string" && record.schema.trim()
      ? { schema: record.schema.trim() }
      : {}),
  };
}

function readObjectRef(value: unknown): ObjectRef {
  const record = asRecord(value);
  if (!record) {
    throw new Error("JOIN knowledge: object must be an object with a name.");
  }
  return {
    name: asIdentifier(record.name, "object.name"),
    ...(typeof record.database === "string" && record.database.trim()
      ? { database: record.database.trim() }
      : {}),
    ...(typeof record.schema === "string" && record.schema.trim()
      ? { schema: record.schema.trim() }
      : {}),
  };
}

function readColumns(value: unknown): RelationColumn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("JOIN knowledge: columns must be a non-empty array of left/right pairs.");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`JOIN knowledge: columns[${index}] must be a left/right pair.`);
    }
    return {
      left: asIdentifier(record.left, `columns[${index}].left`),
      right: asIdentifier(record.right, `columns[${index}].right`),
    };
  });
}

function readRelationInput(value: unknown): JoinRelationCommandInput {
  const record = asRecord(Array.isArray(value) ? value[0] : value);
  if (!record) {
    throw new Error("JOIN knowledge: relation input is required.");
  }
  return {
    left: readTableRef(record.left, "left"),
    right: readTableRef(record.right, "right"),
    columns: readColumns(record.columns),
    ...(typeof record.databaseKind === "string" ? { databaseKind: record.databaseKind } : {}),
    ...(typeof record.effectiveDatabase === "string" ? { effectiveDatabase: record.effectiveDatabase } : {}),
    ...(typeof record.effectiveSchema === "string" ? { effectiveSchema: record.effectiveSchema } : {}),
  };
}

function readObjectInput(value: unknown): SqlObjectCommandInput {
  const record = asRecord(Array.isArray(value) ? value[0] : value);
  if (!record) {
    throw new Error("JOIN knowledge: object input is required.");
  }
  return {
    object: readObjectRef(record.object),
    ...(typeof record.databaseKind === "string" ? { databaseKind: record.databaseKind } : {}),
    ...(typeof record.effectiveDatabase === "string" ? { effectiveDatabase: record.effectiveDatabase } : {}),
    ...(typeof record.effectiveSchema === "string" ? { effectiveSchema: record.effectiveSchema } : {}),
    ...(typeof record.band === "number" ? { band: record.band } : {}),
    ...(typeof record.pinOrder === "number" ? { pinOrder: record.pinOrder } : {}),
  };
}

function readOverrideId(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const record = asRecord(candidate);
  const id = typeof candidate === "string"
    ? candidate
    : typeof record?.id === "string"
      ? record.id
      : undefined;
  if (!id) {
    throw new Error("JOIN knowledge: override id is required.");
  }
  return id;
}

export interface JoinKnowledgeCommandOptions {
  getIndexStatus?: () => WorkspaceIndexStatus | undefined;
  rebuildIndex?: () => Promise<WorkspaceIndexStatus>;
  getJoinSuggestions?: (
    documentUri: string,
    position: { line: number; character: number },
  ) => Promise<JoinKnowledgeSuggestionItem[]>;
  /** Replay the query history into executed evidence. */
  learnFromHistory?: () => Promise<HistoryBackfillResult | undefined>;
  /** Local shown/accepted counters of JOIN ghost text. */
  getGhostStats?: () => JoinGhostStatsSnapshot;
}

function formatSkipReasons(
  skipped: WorkspaceIndexStatus["skipped"],
): string {
  const entries = Object.entries(skipped)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((left, right) => left[0].localeCompare(right[0], "en"))
    .map(([reason, count]) => `${reason}: ${count}`);
  return entries.length > 0 ? entries.join(", ") : "none";
}

function formatIndexStatus(status: WorkspaceIndexStatus | undefined): string[] {
  if (!status) {
    return ["Workspace index: unavailable in this host"];
  }
  const gitMode = status.enabled ? status.git.mode : "disabled";
  let gitText: string;
  if (gitMode === "disabled") {
    gitText = "disabled";
  } else if (gitMode === "unavailable") {
    gitText = "unavailable (mtime fallback)";
  } else if (gitMode === "all") {
    gitText = "all files (window 0)";
  } else {
    gitText = `window ${status.git.windowDays} day(s)`
      + (status.git.head ? `, HEAD ${status.git.head.slice(0, 12)}` : "");
  }
  const truncationReasons = status.truncationReasons.slice(0, 5);
  const hiddenTruncation = status.truncationReasons.length - truncationReasons.length;
  const truncation = status.truncated
    ? `${truncationReasons.join(", ")}${hiddenTruncation > 0 ? ` (+${hiddenTruncation} more)` : ""}`
    : "none";
  return [
    `Workspace index: ${status.enabled ? "enabled" : "disabled"}`
      + `${status.running ? ", running" : ""}`,
    `Files: ${status.enabled ? status.filesIndexed : 0} indexed / `
      + `${status.filesSelected} selected`
      + ` (${status.git.open} open, ${status.git.dirty} dirty, ${status.git.untracked} untracked)`,
    `Workspace JOIN relations: ${status.relations.eligible} eligible, `
      + `${status.relations.belowThreshold} below threshold`,
    `Workspace FROM objects: ${status.objects.eligible} eligible, `
      + `${status.objects.belowThreshold} below threshold`,
    `Workspace columns: ${status.columns?.eligible ?? 0} eligible, `
      + `${status.columns?.belowThreshold ?? 0} below threshold`
      + `${status.columns?.truncated ? " (truncated)" : ""}`,
    `Git mode: ${gitText}`,
    `Truncation: ${truncation}`,
    `Skipped evidence: ${formatSkipReasons(status.skipped)}`,
    ...(status.lastIndexedAt ? [`Last indexed: ${status.lastIndexedAt}`] : []),
    ...(status.lastError ? [`Last error: ${status.lastError}`] : []),
  ];
}

async function showJoinSuggestionActions(
  service: JoinKnowledgeService,
  getSuggestions: JoinKnowledgeCommandOptions["getJoinSuggestions"],
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "sql") {
    void vscode.window.showInformationMessage(
      "Open a SQL editor and place the cursor at a JOIN suggestion first.",
    );
    return;
  }
  const suggestions = getSuggestions
    ? await getSuggestions(editor.document.uri.toString(), {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      })
    : [];
  const relationItems = suggestions.flatMap((suggestion) => {
    try {
      return [{
        item: suggestion,
        relation: readRelationInput(suggestion.relation),
        favorite: suggestion.favorite,
      }];
    } catch {
      return [];
    }
  });
  if (relationItems.length === 0) {
    void vscode.window.showInformationMessage(
      "No JOIN knowledge suggestion at the cursor.",
    );
    return;
  }
  const sqlConfiguration = vscode.workspace.getConfiguration("justybase.sql");
  const configuredRelations = sqlConfiguration.get<unknown>("joinRelations", []);
  const configuredKeys = new Set(
    (Array.isArray(configuredRelations) ? configuredRelations : [])
      .flatMap((value) => {
        try {
          const input = readRelationInput(value);
          const canonical = canonicalizeRelation(
            { left: input.left, right: input.right, columns: input.columns },
            input.databaseKind ?? "netezza",
            {
              database: input.effectiveDatabase,
              schema: input.effectiveSchema,
            },
          );
          return canonical ? [canonical.key] : [];
        } catch {
          return [];
        }
      }),
  );
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & {
    relation: JoinRelationCommandInput;
    favorite: boolean;
    configured: boolean;
  }>();
  quickPick.title = "JOIN suggestion actions";
  quickPick.placeholder = "Use ♥ to prefer · use + to save as a manual relation";
  const toQuickPickItem = (entry: {
    label: string;
    detail?: string;
    relation: JoinRelationCommandInput;
    favorite: boolean;
    configured: boolean;
  }): vscode.QuickPickItem & {
    relation: JoinRelationCommandInput;
    favorite: boolean;
    configured: boolean;
  } => ({
    label: entry.label,
    description: entry.detail,
    detail: entry.configured
      ? "Already in manual relations (tier 0_0_)"
      : entry.favorite
        ? "♥ Preferred"
        : "Use the heart to adjust preference",
    buttons: [
      {
        iconPath: new vscode.ThemeIcon(entry.favorite ? "heart-filled" : "heart"),
        tooltip: entry.favorite ? "Remove preference" : "Prefer this JOIN",
      },
      ...(!entry.configured
        ? [{
            iconPath: new vscode.ThemeIcon("add"),
            tooltip: "Add to manual JOIN relations (rank 0_0_)",
          }]
        : []),
    ],
    relation: entry.relation,
    favorite: entry.favorite,
    configured: entry.configured,
  });
  let quickPickItems = relationItems.map((entry) => toQuickPickItem({
    label: entry.item.label,
    detail: entry.item.detail,
    relation: entry.relation,
    favorite: entry.favorite,
    configured: configuredKeys.has(canonicalizeRelation(
      { left: entry.relation.left, right: entry.relation.right, columns: entry.relation.columns },
      entry.relation.databaseKind ?? "netezza",
      {
        database: entry.relation.effectiveDatabase,
        schema: entry.relation.effectiveSchema,
      },
    )?.key ?? ""),
  }));
  quickPick.items = quickPickItems;
  quickPick.onDidTriggerItemButton(async (event) => {
    const entry = event.item as (typeof quickPickItems)[number];
    if (event.button.tooltip === "Add to manual JOIN relations (rank 0_0_)") {
      try {
        const canonical = canonicalizeRelation(
          { left: entry.relation.left, right: entry.relation.right, columns: entry.relation.columns },
          entry.relation.databaseKind ?? "netezza",
          {
            database: entry.relation.effectiveDatabase,
            schema: entry.relation.effectiveSchema,
          },
        );
        if (!canonical) {
          throw new Error("This JOIN suggestion has an invalid relation identity.");
        }
        if (configuredKeys.has(canonical.key)) {
          void vscode.window.showInformationMessage("This JOIN relation is already configured manually.");
          return;
        }
        if (!vscode.workspace.workspaceFolders?.length) {
          throw new Error("Open a workspace before adding a manual JOIN relation.");
        }
        const choice = await vscode.window.showWarningMessage(
          `Add ${entry.label} as a manual JOIN relation?`,
          {
            modal: true,
            detail: "Manual relations rank at 0_0_ and take precedence over learned suggestions. This writes justybase.sql.joinRelations in workspace settings.",
          },
          "Add relation",
        );
        if (choice !== "Add relation") {
          return;
        }
        const current = sqlConfiguration.get<unknown>("joinRelations", []);
        const existing = Array.isArray(current) ? current : [];
        const relationKey = canonical.key;
        const alreadyAdded = existing.some((value) => {
          try {
            const configured = readRelationInput(value);
            return canonicalizeRelation(
              { left: configured.left, right: configured.right, columns: configured.columns },
              configured.databaseKind ?? "netezza",
              {
                database: configured.effectiveDatabase,
                schema: configured.effectiveSchema,
              },
            )?.key === relationKey;
          } catch {
            return false;
          }
        });
        if (alreadyAdded) {
          void vscode.window.showInformationMessage("This JOIN relation is already configured manually.");
          return;
        }
        await sqlConfiguration.update(
          "joinRelations",
          [...existing, {
            left: canonical.display.left,
            right: canonical.display.right,
            columns: canonical.display.columns,
          }],
          vscode.ConfigurationTarget.Workspace,
        );
        configuredKeys.add(relationKey);
        quickPickItems = quickPickItems.map((item) => item === entry
          ? toQuickPickItem({
              label: item.label,
              detail: item.description,
              relation: item.relation,
              favorite: item.favorite,
              configured: true,
            })
          : item);
        quickPick.items = quickPickItems;
        void vscode.window.showInformationMessage("JOIN relation added to workspace settings.");
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(
          `Could not add manual JOIN relation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    try {
      const result = await service.toggleFavoriteRelation(entry.relation);
      quickPickItems = quickPickItems.map((item) => item === entry
        ? toQuickPickItem({
            label: item.label,
            detail: item.description,
            relation: item.relation,
            favorite: result.favorited,
            configured: item.configured,
          })
        : item);
      quickPick.items = quickPickItems;
      void vscode.window.showInformationMessage(
        result.favorited
          ? result.blocked
            ? "JOIN favorite stored; the relation is currently blocked and stays hidden."
            : "JOIN favorite stored. It ranks in the preference band, never above catalog FK."
          : "JOIN favorite removed.",
      );
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(
        `Could not update JOIN favorite: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  quickPick.onDidAccept(() => quickPick.hide());
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/** Register manual decisions, index commands and the quick favorite action. */
/** Counters only: no SQL, identifiers or values. */
function formatExecutionStatus(
  executed: JoinKnowledgeDiagnostics["executed"],
  capture: JoinKnowledgeExecutionCounters | undefined,
): string[] {
  const skipped = capture
    ? Object.entries(capture.skipped)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ") || "none"
    : "not started";
  return [
    `Executed evidence: ${executed.relationsEligible} relation(s) eligible, ` +
      `${executed.relationsBelowThreshold} below threshold; ` +
      `${executed.objectsEligible} object(s) eligible, ${executed.objectsBelowThreshold} below threshold; ` +
      `${executed.columnsEligible} column(s) eligible, ${executed.columnsBelowThreshold} below threshold` +
      `${executed.truncated ? "; truncated by a retention limit" : ""}`,
    `Execution capture: ${capture?.observed ?? 0} observed, ${capture?.recorded ?? 0} recorded, ` +
      `${capture?.duplicates ?? 0} duplicate, ${capture?.notDurable ?? 0} not saved; skipped: ${skipped}`,
  ];
}

export function registerJoinKnowledgeCommands(
  service: JoinKnowledgeService,
  options: JoinKnowledgeCommandOptions = {},
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "netezza.confirmJoinKnowledgeRelation",
      async (value?: unknown) => service.confirmRelation(readRelationInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.blockJoinKnowledgeRelation",
      async (value?: unknown) => service.blockRelation(readRelationInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.revertJoinKnowledgeOverride",
      async (value?: unknown) => service.revertRelationOverride(readOverrideId(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.favoriteJoinKnowledgeRelation",
      async (value?: unknown) => service.toggleFavoriteRelation(readRelationInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.recordJoinKnowledgeAcceptance",
      async (value?: unknown) => {
        try {
          return await service.recordAcceptedRelation(readRelationInput(value));
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(
            `Could not remember the accepted JOIN suggestion: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "netezza.recordSqlObjectAcceptance",
      async (value?: unknown) => {
        try {
          return await service.recordAcceptedObject(readObjectInput(value));
        } catch {
          // A failed preference write must never interrupt typing.
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "netezza.favoriteJoinKnowledgeSuggestion",
      async () => showJoinSuggestionActions(service, options.getJoinSuggestions),
    ),
    vscode.commands.registerCommand(
      "netezza.pinSqlObject",
      async (value?: unknown) => service.pinObject(readObjectInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.boostSqlObject",
      async (value?: unknown) => service.boostObject(readObjectInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.demoteSqlObject",
      async (value?: unknown) => service.demoteObject(readObjectInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.excludeSqlObject",
      async (value?: unknown) => service.excludeObject(readObjectInput(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.revertSqlObjectPreference",
      async (value?: unknown) => service.revertObjectPreference(readOverrideId(value)),
    ),
    vscode.commands.registerCommand(
      "netezza.rebuildJoinKnowledgeIndex",
      async () => {
        if (!options.rebuildIndex) {
          throw new Error("Workspace JOIN indexing is unavailable in this host.");
        }
        const status = await options.rebuildIndex();
        void vscode.window.showInformationMessage(
          [
            "JOIN workspace index rebuilt",
            ...formatIndexStatus(status),
          ].join("\n"),
        );
        return status;
      },
    ),
    vscode.commands.registerCommand(
      "netezza.learnJoinKnowledgeFromHistory",
      async () => {
        const enabled = vscode.workspace
          .getConfiguration("justybase.sql")
          .get<boolean>("learnFromExecutedQueries", true) !== false;
        if (!enabled || !options.learnFromHistory) {
          void vscode.window.showInformationMessage(
            "Learning from executed SQL is turned off (justybase.sql.learnFromExecutedQueries).",
          );
          return undefined;
        }
        // The runner shows progress and the outcome itself.
        return options.learnFromHistory();
      },
    ),
    vscode.commands.registerCommand(
      "netezza.showJoinKnowledgeStatus",
      async () => {
        const diagnostics = service.getDiagnostics();
        const personalizeFromObjects = vscode.workspace
          .getConfiguration("justybase.sql")
          .get<boolean>("personalizeFromObjects", true);
        const personalizeColumns = vscode.workspace
          .getConfiguration("justybase.sql")
          .get<boolean>("personalizeColumns", true);
        const indexStatus = options.getIndexStatus?.();
        const ghostText = options.getGhostStats?.();
        const summary = [
          "JOIN knowledge status",
          `Relations: ${diagnostics.relationOverrides.active} active ` +
            `(${diagnostics.relationOverrides.confirmed} confirmed, ` +
            `${diagnostics.relationOverrides.blocked} blocked, ` +
            `${diagnostics.relationOverrides.favorites} favorite), ` +
            `${diagnostics.relationOverrides.reverted} reverted`,
          `Objects: ${diagnostics.objectOverrides.active} active ` +
            `(${diagnostics.objectOverrides.pinned} pinned, ` +
            `${diagnostics.objectOverrides.boosted} boosted, ` +
            `${diagnostics.objectOverrides.demoted} demoted, ` +
            `${diagnostics.objectOverrides.excluded} excluded), ` +
            `${diagnostics.objectOverrides.reverted} reverted`,
          `FROM personalization: ${personalizeFromObjects ? "enabled" : "disabled"}`,
          `Column ordering by usage: ${personalizeColumns ? "enabled" : "disabled"}`,
          ...formatIndexStatus(indexStatus),
          ...formatExecutionStatus(diagnostics.executed, getJoinKnowledgeExecutionCapture()?.getCounters()),
          ...(ghostText ? formatJoinGhostStats(ghostText) : []),
          "Favorite is a preference (tier 0_3_), not confirmation; a block still wins.",
          "Block decisions also suppress matching justybase.sql.joinRelations entries; revert the block to restore the configured relation.",
        ].join("\n");
        void vscode.window.showInformationMessage(summary);
        return {
          ...diagnostics,
          ...(indexStatus ? { workspaceIndex: indexStatus } : {}),
          ...(ghostText ? { ghostText } : {}),
        };
      },
    ),
    ...registerJoinKnowledgePortabilityCommands(service),
  ];
}
