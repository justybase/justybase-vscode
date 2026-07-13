import * as vscode from "vscode";

const contextValues = new Map<string, unknown>();

/** Avoids flooding the Extension Host command queue with unchanged context keys. */
export function setContextIfChanged(key: string, value: unknown): void {
  if (contextValues.has(key) && Object.is(contextValues.get(key), value)) {
    return;
  }
  contextValues.set(key, value);
  void vscode.commands.executeCommand("setContext", key, value);
}

/** Test-only reset for suites that recreate the extension in one process. */
export function resetContextKeyStateForTests(): void {
  contextValues.clear();
}
