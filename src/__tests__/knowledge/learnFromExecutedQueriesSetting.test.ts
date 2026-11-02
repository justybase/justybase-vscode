jest.mock("vscode");

import * as vscode from "vscode";
import { isLearnFromExecutedQueriesEnabled } from "../../activation/joinKnowledgeRegistration";

const packageJson = require("../../../package.json") as {
  contributes: { configuration: Array<{ properties?: Record<string, { default?: unknown }> }> | { properties?: Record<string, { default?: unknown }> } };
};

function setting(name: string): { default?: unknown } | undefined {
  const sections = Array.isArray(packageJson.contributes.configuration)
    ? packageJson.contributes.configuration
    : [packageJson.contributes.configuration];
  return sections.map((section) => section.properties?.[name]).find(Boolean);
}

describe("learning defaults", () => {
  it("learns from executed queries by default but not from workspace SQL files", () => {
    expect(setting("justybase.sql.learnFromExecutedQueries")?.default).toBe(true);
    expect(setting("justybase.sql.joinKnowledgeIndex")?.default).toBe(false);
    expect(isLearnFromExecutedQueriesEnabled()).toBe(true);
  });

  it("stops execution learning when the user turns it off", () => {
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({ get: () => false });
    expect(isLearnFromExecutedQueriesEnabled()).toBe(false);
  });
});
