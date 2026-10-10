import { Range } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

export function offsetRangeToRange(
  document: TextDocument,
  startOffset: number,
  endOffset: number,
): Range {
  const safeStart = Math.max(0, startOffset);
  const safeEnd = Math.max(safeStart + 1, endOffset);
  return Range.create(
    document.positionAt(safeStart),
    document.positionAt(safeEnd),
  );
}
