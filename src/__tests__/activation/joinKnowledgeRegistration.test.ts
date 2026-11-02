import * as path from "node:path";
import type * as vscode from "vscode";
import { resolveJoinKnowledgeStorageRoot } from "../../activation/joinKnowledgeRegistration";

jest.mock("vscode");

function context(
  workspaceStorage: string | undefined,
  globalStorage = "/global-storage",
): Pick<vscode.ExtensionContext, "storageUri" | "globalStorageUri"> {
  return {
    storageUri: workspaceStorage
      ? { fsPath: workspaceStorage } as vscode.Uri
      : undefined,
    globalStorageUri: { fsPath: globalStorage } as vscode.Uri,
  };
}

describe("JOIN knowledge storage root", () => {
  it("keeps two workspaces on separate decision directories", () => {
    const first = resolveJoinKnowledgeStorageRoot(context("/workspace-a"));
    const second = resolveJoinKnowledgeStorageRoot(context("/workspace-b"));

    expect(first).toBe(path.join("/workspace-a", "join-knowledge"));
    expect(second).toBe(path.join("/workspace-b", "join-knowledge"));
    expect(first).not.toBe(second);
  });

  it("falls back to global storage only when no workspace storage exists", () => {
    expect(resolveJoinKnowledgeStorageRoot(context(undefined)))
      .toBe(path.join("/global-storage", "join-knowledge"));
  });

  it("returns undefined when the host provides no storage URI", () => {
    expect(resolveJoinKnowledgeStorageRoot({
      storageUri: undefined,
      globalStorageUri: undefined,
    } as unknown as Pick<vscode.ExtensionContext, "storageUri" | "globalStorageUri">))
      .toBeUndefined();
  });
});
