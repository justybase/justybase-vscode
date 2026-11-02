jest.mock("vscode");

import * as vscode from "vscode";
import { createHistoryLearning } from "../../activation/joinKnowledgeHistoryLearning";
import type { HistoryBackfillResult } from "../../knowledge/joinKnowledgeExecution";
import {
  HISTORY_BACKFILL_DONE_KEY,
  HISTORY_LEARNING_ANNOUNCED_KEY,
} from "../../knowledge/joinKnowledgeHistoryBackfill";
import type { JoinKnowledgeService } from "../../knowledge/joinKnowledgeService";

jest.mock("../../core/queryHistoryManager", () => ({
  QueryHistoryManager: { getInstance: () => ({ getAllHistory: async () => [] }) },
}));

function memento() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: jest.fn(async (key: string, value: unknown) => { values.set(key, value); }),
  };
}

function setup(learned: { joins: number; tables: number }) {
  let joins = 0;
  let tables = 0;
  const result: HistoryBackfillResult = { scanned: 10, eligible: 10, recorded: 10, duplicates: 0, notDurable: 0, skipped: {} };
  const capture = {
    backfillFromHistory: jest.fn(async () => {
      joins += learned.joins;
      tables += learned.tables;
      return result;
    }),
  };
  const service = {
    getDiagnostics: () => ({ executed: { relationsEligible: joins, objectsEligible: tables } }),
  } as unknown as JoinKnowledgeService;
  const context = { workspaceState: memento(), globalState: memento() } as unknown as vscode.ExtensionContext;
  const learning = createHistoryLearning({
    context,
    service,
    capture: capture as never,
    isEnabled: () => true,
    getConnectionDatabaseKind: () => "netezza",
  });
  return { learning, context, capture };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("history learning UI", () => {
  beforeEach(() => jest.clearAllMocks());

  it("runs quietly in the status bar and announces the first useful result once", async () => {
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
    const { learning, context } = setup({ joins: 3, tables: 5 });

    learning.runAutomatic();
    await flush();

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ location: vscode.ProgressLocation.Window }),
      expect.any(Function),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Learned from 10 past queries: 3 JOINs and 5 tables you use repeatedly now rank higher in suggestions.",
      "Show What Was Learned",
      "Turn Off",
    );
    expect(context.workspaceState.get(HISTORY_BACKFILL_DONE_KEY)).toBe(true);
    expect(context.globalState.get(HISTORY_LEARNING_ANNOUNCED_KEY)).toBe(true);

    // Done for this workspace: a second automatic run does nothing.
    learning.runAutomatic();
    await flush();
    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
  });

  it("stays silent when nothing was learned", async () => {
    const { learning, context } = setup({ joins: 0, tables: 0 });

    learning.runAutomatic();
    await flush();

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(context.workspaceState.get(HISTORY_BACKFILL_DONE_KEY)).toBe(true);
    expect(context.globalState.get(HISTORY_LEARNING_ANNOUNCED_KEY)).toBeUndefined();
  });

  it("opens the manager on executed evidence, or turns learning off", async () => {
    const show = setup({ joins: 0, tables: 2 });
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce("Show What Was Learned");
    show.learning.runAutomatic();
    await flush();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "netezza.openJoinKnowledge",
      { tab: "objects", filter: "executed" },
    );

    const update = jest.fn(async () => undefined);
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get: (_key: string, value: unknown) => value, update });
    const off = setup({ joins: 1, tables: 0 });
    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce("Turn Off")
      .mockResolvedValueOnce(undefined);
    off.learning.runAutomatic();
    await flush();
    await flush();
    expect(update).toHaveBeenCalledWith("learnFromExecutedQueries", false, vscode.ConfigurationTarget.Global);
  });

  it("runs from the command with cancellable progress and reports the outcome", async () => {
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
    const { learning, capture } = setup({ joins: 0, tables: 0 });

    const result = await learning.runInteractive();

    expect(result?.eligible).toBe(10);
    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ location: vscode.ProgressLocation.Notification, cancellable: true }),
      expect.any(Function),
    );
    expect(capture.backfillFromHistory).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ isCancelled: expect.any(Function), onProgress: expect.any(Function) }),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Checked 10 past queries; no JOINs or tables were used often enough to rank higher yet.",
    );
  });
});
