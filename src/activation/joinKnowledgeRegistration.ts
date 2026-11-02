import * as vscode from "vscode";
import path from "node:path";
import { registerJoinKnowledgeCommands } from "../commands/joinKnowledgeCommands";
import { FileJoinKnowledgePersistence } from "../knowledge/joinKnowledgeFilePersistence";
import {
  setJoinKnowledgeExecutionCapture,
  setJoinKnowledgeService,
  setWorkspaceIndexCoordinator,
} from "../knowledge/joinKnowledgeRuntime";
import { JoinKnowledgeExecutionCapture } from "../knowledge/joinKnowledgeExecution";
import { createHistoryLearning } from "./joinKnowledgeHistoryLearning";
import type { DatabaseKind } from "../contracts/database";
import {
  JoinKnowledgeService,
  type JoinKnowledgePersistence,
} from "../knowledge/joinKnowledgeService";
import { WorkspaceIndexCoordinator } from "../knowledge/workspaceIndexCoordinator";
import type { JoinKnowledgeState } from "@justybase/sql-core/joinKnowledge";
import { tryGetLogger } from "../utils/logger";
import {
  ACCEPT_JOIN_GHOST_COMMAND,
  JoinGhostTextProvider,
  readGhostTextSettings,
} from "../providers/joinGhostTextProvider";
import { JoinGhostStats, type JoinGhostSlot } from "../knowledge/joinGhostStats";
import { SQL_AUTHORING_LANGUAGE_IDS } from "../utils/sqlLanguage";
import * as lspRegistration from "./lspRegistration";

export function resolveJoinKnowledgeStorageRoot(
  context: Pick<vscode.ExtensionContext, "storageUri" | "globalStorageUri">,
): string | undefined {
  // Manual decisions are workspace-scoped, like `justybase.sql.joinRelations`.
  // A window without a workspace has no storageUri; the global fallback keeps
  // such a window usable without sharing decisions between real workspaces.
  const workspaceStorage = context.storageUri?.fsPath;
  const root = workspaceStorage ?? context.globalStorageUri?.fsPath;
  return root ? path.join(root, "join-knowledge") : undefined;
}

/** Used when VS Code provides no storage URI (tests, headless hosts). */
class InMemoryJoinKnowledgePersistence implements JoinKnowledgePersistence {
  private state: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };

  async load(): Promise<JoinKnowledgeState> {
    return this.state;
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    this.state = state;
  }
}

/**
 * Stage 1 activation: load manual decisions, register commands and keep the
 * language server's in-memory ranking snapshot current.
 */
export async function activateJoinKnowledge(
  context: vscode.ExtensionContext,
  options: {
    /** Dialect of a saved connection; used to replay the query history. */
    getConnectionDatabaseKind?: (connectionName?: string) => DatabaseKind | undefined;
  } = {},
): Promise<JoinKnowledgeService> {
  const storageRoot = resolveJoinKnowledgeStorageRoot(context);
  const service = new JoinKnowledgeService(
    storageRoot
      ? new FileJoinKnowledgePersistence(storageRoot)
      : new InMemoryJoinKnowledgePersistence(),
    {
      logger: {
        info: (message) => tryGetLogger()?.info(message),
        warn: (message) => tryGetLogger()?.warn(message),
      },
    },
  );
  setJoinKnowledgeService(service);
  await service.initialize();
  const isExecutionLearningEnabled = (): boolean => isLearnFromExecutedQueriesEnabled();
  const capture = new JoinKnowledgeExecutionCapture({
    getService: () => service,
    isEnabled: isExecutionLearningEnabled,
  });
  setJoinKnowledgeExecutionCapture(capture);
  const historyLearning = createHistoryLearning({
    context,
    service,
    capture,
    isEnabled: isExecutionLearningEnabled,
    getConnectionDatabaseKind: options.getConnectionDatabaseKind,
  });
  const learnFromHistory = () => historyLearning.runInteractive();
  // Existing users already ran many statements: learn from them once per
  // workspace when execution learning is on, without delaying activation.
  const backfillOnce = (): void => historyLearning.runAutomatic();

  const index = storageRoot
    ? new WorkspaceIndexCoordinator({
        storageRoot,
        logger: {
          info: (message) => tryGetLogger()?.info(message),
          warn: (message) => tryGetLogger()?.warn(message),
        },
        onDidChangeIndex: (delta) => {
          if (delta) {
            lspRegistration.notifyJoinKnowledgeIndexChanged?.(delta);
          } else {
            lspRegistration.notifyJoinKnowledgeChanged?.();
          }
        },
      })
    : undefined;
  setWorkspaceIndexCoordinator(index);
  if (index) {
    await index.start();
    context.subscriptions.push(index);
  }

  const ghostStats = new JoinGhostStats(context.globalState);
  context.subscriptions.push(...registerJoinKnowledgeCommands(service, {
    getGhostStats: () => ghostStats.snapshot(),
    getIndexStatus: () => index?.getStatus(),
    rebuildIndex: index ? () => index.rebuild() : undefined,
    getJoinSuggestions: (documentUri, position) =>
      lspRegistration.requestJoinKnowledgeSuggestions(documentUri, position),
    learnFromHistory,
  }));
  context.subscriptions.push(service.onDidChange(() => lspRegistration.notifyJoinKnowledgeChanged?.()));
  const ghostTextProvider = new JoinGhostTextProvider(
    (documentUri, position, mode, groupBy) =>
      lspRegistration.requestJoinGhostSuggestion(documentUri, position, mode, groupBy),
    readGhostTextSettings,
    ghostStats,
  );
  context.subscriptions.push(vscode.commands.registerCommand(
    ACCEPT_JOIN_GHOST_COMMAND,
    async (relation?: unknown, slot?: JoinGhostSlot) => {
      if (slot) {
        void ghostStats.recordAccepted(slot);
      }
      // A GROUP BY list carries no relation to remember.
      return relation === undefined
        ? true
        : vscode.commands.executeCommand<boolean>("netezza.recordJoinKnowledgeAcceptance", relation);
    },
  ));
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(
    SQL_AUTHORING_LANGUAGE_IDS.flatMap((language) => [
      { scheme: "file", language },
      { scheme: "untitled", language },
    ]),
    ghostTextProvider,
  ));
  if (process.env.NODE_ENV === "test") {
    // VS Code has no command that runs inline completion providers; the
    // Extension Host smoke drives the registered provider through this one.
    context.subscriptions.push(vscode.commands.registerCommand(
      "justybase.test.joinGhostText",
      (uri: vscode.Uri, position: vscode.Position, suggestWidgetOpen = false) =>
        provideJoinGhostForTest(ghostTextProvider, uri, position, suggestWidgetOpen),
    ));
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("justybase.sql.personalizeFromObjects")
        || event.affectsConfiguration("justybase.sql.personalizeColumns")
      ) {
        lspRegistration.notifyJoinKnowledgeChanged?.();
      }
      if (event.affectsConfiguration("justybase.sql.learnFromExecutedQueries")) {
        backfillOnce();
      }
    }),
  );
  const backfillTimer = setTimeout(backfillOnce, 5_000);
  backfillTimer.unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(backfillTimer) });
  context.subscriptions.push({
    dispose: () => {
      setWorkspaceIndexCoordinator(undefined);
      setJoinKnowledgeExecutionCapture(undefined);
      setJoinKnowledgeService(undefined);
    },
  });
  lspRegistration.notifyJoinKnowledgeChanged?.();
  return service;
}

async function provideJoinGhostForTest(
  provider: JoinGhostTextProvider,
  uri: vscode.Uri,
  position: vscode.Position,
  suggestWidgetOpen: boolean,
): Promise<{ insertText: string; command?: string; commandArguments?: unknown[] } | undefined> {
  const document = await vscode.workspace.openTextDocument(uri);
  const tokenSource = new vscode.CancellationTokenSource();
  try {
    const items = await provider.provideInlineCompletionItems(document, position, {
      triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
      selectedCompletionInfo: suggestWidgetOpen
        ? { range: new vscode.Range(position, position), text: "" }
        : undefined,
    } as vscode.InlineCompletionContext, tokenSource.token);
    const item = items?.[0];
    return item
      ? {
        insertText: String(item.insertText),
        command: item.command?.command,
        commandArguments: item.command?.arguments,
      }
      : undefined;
  } finally {
    tokenSource.dispose();
  }
}

/** `justybase.sql.learnFromExecutedQueries` (default on): capture executions and replay the history. */
export function isLearnFromExecutedQueriesEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("justybase.sql")
    .get<boolean>("learnFromExecutedQueries", true) !== false;
}
