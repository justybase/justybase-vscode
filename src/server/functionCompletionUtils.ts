import { MarkupKind, type MarkupContent } from "vscode-languageserver/node";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import { toInlineCompletionDescription } from "./completionDescriptionUtils";

export function buildFunctionCompletionDetail(
  signatures: readonly DatabaseSqlFunctionSignature[] | undefined,
): string {
  if (!signatures?.length) {
    return "SQL Function";
  }
  const signature = signatures[0];
  return `${signature.name}(${signature.parameters.join(", ")})`;
}

export function buildFunctionInlineDescription(
  signatures: readonly DatabaseSqlFunctionSignature[] | undefined,
): string | undefined {
  if (!signatures?.length) {
    return undefined;
  }
  return toInlineCompletionDescription(signatures[0].description);
}

export function buildFunctionSignatureDocumentation(
  signatures: readonly DatabaseSqlFunctionSignature[] | undefined,
): MarkupContent | undefined {
  if (!signatures?.length) {
    return undefined;
  }

  const sections = signatures.map((signature) => {
    const lines = [
      `**${signature.name}(${signature.parameters.join(", ")})**`,
      signature.description,
    ];
    if (signature.example?.trim()) {
      lines.push("", "Example:", "```sql", signature.example.trim(), "```");
    }
    return lines.join("\n");
  });

  return {
    kind: MarkupKind.Markdown,
    value: sections.join("\n\n"),
  };
}
