import * as vscode from "vscode";
import type { DatabaseKind } from "../contracts/database";
import type { JoinKnowledgeManagerFocus } from "../contracts/joinKnowledgeManager";
import type { HistoryBackfillResult, JoinKnowledgeExecutionCapture } from "../knowledge/joinKnowledgeExecution";
import {
  backfillJoinKnowledgeFromHistory,
  formatHistoryBackfillResult,
  formatHistoryLearningMessage,
  HISTORY_BACKFILL_DONE_KEY,
  HISTORY_LEARNING_ANNOUNCED_KEY,
  learnedKnowledgeCounts,
  learnedKnowledgeGain,
  type LearnedKnowledgeCounts,
} from "../knowledge/joinKnowledgeHistoryBackfill";
import type { JoinKnowledgeService } from "../knowledge/joinKnowledgeService";
import { tryGetLogger } from "../utils/logger";

const SHOW_LEARNED = "Show What Was Learned";
const TURN_OFF = "Turn Off";

export interface HistoryLearningDependencies {
  context: vscode.ExtensionContext;
  service: JoinKnowledgeService;
  capture: JoinKnowledgeExecutionCapture;
  isEnabled: () => boolean;
  getConnectionDatabaseKind?: (connectionName?: string) => DatabaseKind | undefined;
}

export interface HistoryLearning {
  /** Once per workspace, in the background: status-bar progress, one notification ever. */
  runAutomatic(): void;
  /** Command: cancellable progress notification and an outcome message. */
  runInteractive(): Promise<HistoryBackfillResult | undefined>;
}

/**
 * Learning from the query history, presented like background indexing: a
 * quiet status-bar progress while it runs, and a single notification (the
 * first time anything was learned) that says what changed and offers to
 * look at it or turn learning off.
 */
export function createHistoryLearning(dependencies: HistoryLearningDependencies): HistoryLearning {
  let running: Promise<HistoryBackfillResult | undefined> | undefined;

  const run = async (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken,
  ): Promise<{ result: HistoryBackfillResult | undefined; gain: LearnedKnowledgeCounts }> => {
    const before = learnedKnowledgeCounts(dependencies.service.getDiagnostics());
    let reported = 0;
    const result = await backfillJoinKnowledgeFromHistory({
      capture: dependencies.capture,
      loadHistory: async () => {
        const { QueryHistoryManager } = await import("../core/queryHistoryManager");
        return QueryHistoryManager.getInstance(dependencies.context).getAllHistory();
      },
      getConnectionDatabaseKind: (name) => dependencies.getConnectionDatabaseKind?.(name),
    }, {
      isCancelled: () => token?.isCancellationRequested === true,
      onProgress: (processed, total) => {
        const percent = total > 0 ? Math.floor((processed / total) * 100) : 100;
        progress.report({ message: `${processed} of ${total} queries`, increment: percent - reported });
        reported = percent;
      },
    });
    if (result) {
      tryGetLogger()?.info(`[JoinKnowledge] ${formatHistoryBackfillResult(result)}`);
    }
    const after = learnedKnowledgeCounts(dependencies.service.getDiagnostics());
    return { result, gain: learnedKnowledgeGain(before, after) };
  };

  const exclusive = (task: () => Promise<HistoryBackfillResult | undefined>) => {
    if (!running) {
      running = task().finally(() => {
        running = undefined;
      });
    }
    return running;
  };

  const showLearned = (gain: LearnedKnowledgeCounts): Thenable<unknown> => {
    const focus: JoinKnowledgeManagerFocus = {
      tab: gain.joins > 0 || gain.tables === 0 ? "relations" : "objects",
      filter: "executed",
    };
    return vscode.commands.executeCommand("netezza.openJoinKnowledge", focus);
  };

  const turnOff = async (): Promise<void> => {
    await vscode.workspace
      .getConfiguration("justybase.sql")
      .update("learnFromExecutedQueries", false, vscode.ConfigurationTarget.Global);
    const choice = await vscode.window.showInformationMessage(
      "JustyBase no longer learns from executed queries. What it already learned stays until you clear it in the JOIN Knowledge manager.",
      "Open Manager",
    );
    if (choice) {
      await vscode.commands.executeCommand("netezza.openJoinKnowledge", { tab: "relations", filter: "executed" });
    }
  };

  return {
    runAutomatic(): void {
      const { context } = dependencies;
      if (!dependencies.isEnabled() || context.workspaceState.get<boolean>(HISTORY_BACKFILL_DONE_KEY) || running) {
        return;
      }
      void exclusive(async () => {
        const { result, gain } = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "JustyBase: learning from query history" },
          (progress) => run(progress),
        );
        if (!result || result.skipped.disabled) {
          return result;
        }
        await context.workspaceState.update(HISTORY_BACKFILL_DONE_KEY, true);
        const learnedAnything = gain.joins > 0 || gain.tables > 0;
        if (learnedAnything && !context.globalState.get<boolean>(HISTORY_LEARNING_ANNOUNCED_KEY)) {
          await context.globalState.update(HISTORY_LEARNING_ANNOUNCED_KEY, true);
          void vscode.window.showInformationMessage(
            formatHistoryLearningMessage(result, gain),
            SHOW_LEARNED,
            TURN_OFF,
          ).then((choice) => {
            if (choice === SHOW_LEARNED) {
              void showLearned(gain);
            } else if (choice === TURN_OFF) {
              void turnOff();
            }
          });
        }
        return result;
      });
    },

    runInteractive(): Promise<HistoryBackfillResult | undefined> {
      if (running) {
        void vscode.window.showInformationMessage("JustyBase is already learning from the query history.");
        return running;
      }
      return exclusive(async () => {
        const { result, gain } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Learning from query history",
            cancellable: true,
          },
          (progress, token) => run(progress, token),
        );
        if (result) {
          const actions = gain.joins > 0 || gain.tables > 0 ? [SHOW_LEARNED] : [];
          void vscode.window.showInformationMessage(formatHistoryLearningMessage(result, gain), ...actions)
            .then((choice) => {
              if (choice === SHOW_LEARNED) {
                void showLearned(gain);
              }
            });
        }
        return result;
      });
    },
  };
}
