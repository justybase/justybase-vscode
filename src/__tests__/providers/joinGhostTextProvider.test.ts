jest.mock("vscode");

import * as vscode from "vscode";
import type { JoinGhostSuggestion } from "../../lsp/protocol";
import { JoinGhostStats } from "../../knowledge/joinGhostStats";
import { JoinGhostTextProvider } from "../../providers/joinGhostTextProvider";

const relation = {
  left: { table: "FACT" },
  right: { table: "DIMDATE" },
  columns: [{ left: "DATEKEY", right: "DATEKEY" }],
};
const ghost: JoinGhostSuggestion = { kind: "predicate", insertText: "ON F.DATEKEY = D.DATEKEY", relation };
const document = { uri: { toString: () => "file:///q.sql" } } as unknown as vscode.TextDocument;
const position = new vscode.Position(3, 17);
const token = (cancelled = false) => ({ isCancellationRequested: cancelled }) as vscode.CancellationToken;
const context = (selected = false) => ({
  triggerKind: 1,
  selectedCompletionInfo: selected ? { text: "X", range: new vscode.Range(position, position) } : undefined,
}) as unknown as vscode.InlineCompletionContext;

describe("JoinGhostTextProvider", () => {
  it("inserts the ghost at the cursor and remembers it when accepted", async () => {
    const request = jest.fn(async () => ghost);
    const provider = new JoinGhostTextProvider(request, () => ({ mode: "afterJoin" as const, groupBy: true }));

    const items = await provider.provideInlineCompletionItems(document, position, context(), token());

    expect(request).toHaveBeenCalledWith("file:///q.sql", { line: 3, character: 17 }, "afterJoin", true);
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({
      insertText: "ON F.DATEKEY = D.DATEKEY",
      command: { command: "netezza.acceptJoinGhostSuggestion", arguments: [relation, "condition"] },
    });
  });

  it("asks nothing when off or while the suggest widget shows its own preview", async () => {
    const request = jest.fn(async () => ghost);
    await expect(new JoinGhostTextProvider(request, () => ({ mode: "off" as const, groupBy: false }))
      .provideInlineCompletionItems(document, position, context(), token())).resolves.toBeUndefined();
    await expect(new JoinGhostTextProvider(request, () => ({ mode: "afterJoin" as const, groupBy: true }))
      .provideInlineCompletionItems(document, position, context(true), token())).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("drops a ghost that is not confident or arrives after cancellation", async () => {
    await expect(new JoinGhostTextProvider(async () => null, () => ({ mode: "afterJoin" as const, groupBy: true }))
      .provideInlineCompletionItems(document, position, context(), token())).resolves.toBeUndefined();
    await expect(new JoinGhostTextProvider(async () => ghost, () => ({ mode: "afterJoin" as const, groupBy: true }))
      .provideInlineCompletionItems(document, position, context(), token(true))).resolves.toBeUndefined();
  });

  it("counts a ghost once per position and text", async () => {
    const state = new Map<string, unknown>();
    const stats = new JoinGhostStats({
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    });
    const provider = new JoinGhostTextProvider(async () => ghost, () => ({ mode: "afterJoin" as const, groupBy: true }), stats);

    await provider.provideInlineCompletionItems(document, position, context(), token());
    await provider.provideInlineCompletionItems(document, position, context(), token());
    await provider.provideInlineCompletionItems(document, new vscode.Position(4, 0), context(), token());
    await stats.recordAccepted("condition");

    expect(stats.snapshot()).toEqual({
      afterJoinTarget: { shown: 0, accepted: 0 },
      condition: { shown: 2, accepted: 1 },
      newLineJoin: { shown: 0, accepted: 0 },
      groupBy: { shown: 0, accepted: 0 },
    });
  });

  it("offers the GROUP BY list without a relation, also when JOIN ghosts are off", async () => {
    const groupBy: JoinGhostSuggestion = { kind: "groupBy", insertText: "p.COLOR, d.CALENDARYEAR" };
    const request = jest.fn(async () => groupBy);
    const provider = new JoinGhostTextProvider(request, () => ({ mode: "off" as const, groupBy: true }));

    const items = await provider.provideInlineCompletionItems(document, position, context(), token());

    expect(request).toHaveBeenCalledWith("file:///q.sql", { line: 3, character: 17 }, "off", true);
    expect(items![0]).toMatchObject({
      insertText: "p.COLOR, d.CALENDARYEAR",
      command: { command: "netezza.acceptJoinGhostSuggestion", arguments: [undefined, "groupBy"] },
    });
  });
});
