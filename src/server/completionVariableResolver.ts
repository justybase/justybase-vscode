import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
} from "vscode-languageserver/node";

/**
 * Variable completion helpers for ${var} and {var} insertion modes.
 */
export function handleVariableCompletion(
  linePrefix: string,
  variables: string[],
  triggerKind: CompletionTriggerKind,
): CompletionItem[] | null {
  if (!/\$\{?[a-zA-Z0-9_]*$|(?<!\$)\{[a-zA-Z0-9_]*$/.test(linePrefix)) {
    return null;
  }

  if (triggerKind !== CompletionTriggerKind.Invoked) {
    return null;
  }

  const mode = getVariableInsertionMode(linePrefix);
  return variables.map((variableName) => ({
    label: `\${${variableName}}`,
    kind: CompletionItemKind.Variable,
    detail: "Variable",
    insertText:
      mode === "name-only"
        ? `${variableName}}`
        : mode === "partial"
          ? `{${variableName}}`
          : mode === "braces-only"
            ? `${variableName}}`
            : `\${${variableName}}`,
    filterText: variableName,
    sortText: `0_${variableName}`,
  }));
}

function getVariableInsertionMode(
  linePrefix: string,
): "full" | "partial" | "name-only" | "braces-only" {
  if (linePrefix.endsWith("${")) {
    return "name-only";
  }
  if (linePrefix.endsWith("$")) {
    return "partial";
  }
  if (linePrefix.endsWith("{")) {
    return "braces-only";
  }
  return "full";
}