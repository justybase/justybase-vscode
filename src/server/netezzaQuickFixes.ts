export interface QuickFixPosition {
  line: number;
  character: number;
}

export interface QuickFixRange {
  start: QuickFixPosition;
  end: QuickFixPosition;
}

export interface NetezzaQuickFixDescriptor {
  code: "SQL046" | "NZL006";
  title: string;
  safety: "safe";
  fixAllEligible: boolean;
  edit: {
    range: QuickFixRange;
    newText: string;
  };
}

export const UPDATE_ALIAS_AS_QUICK_FIX = {
  code: "SQL046",
  title: "Remove AS in UPDATE alias",
  safety: "safe",
  fixAllEligible: true,
  newText: "",
} as const;

export const EQUALS_NULL_QUICK_FIX = {
  code: "NZL006",
  title: "Replace = NULL with IS NULL",
  safety: "safe",
  fixAllEligible: false, // changes the result set; explicit-only
  newText: "IS NULL",
} as const;

/**
 * Node-runnable production quick-fix contract shared by the VS Code provider
 * and the conformance adapter. The host-specific provider applies this edit as
 * a WorkspaceEdit; consumers can inspect the same title/safety/edit contract
 * without implementing SQL or quick-fix policy themselves.
 */
export function buildNetezzaQuickFix(
  code: NetezzaQuickFixDescriptor["code"],
  range: QuickFixRange,
  documentText?: string,
): NetezzaQuickFixDescriptor {
  const policy = code === "SQL046"
    ? UPDATE_ALIAS_AS_QUICK_FIX
    : EQUALS_NULL_QUICK_FIX;
  let editRange = range;
  if (code === "SQL046" && documentText !== undefined) {
    const lines = documentText.split(/\r\n|\r|\n/);
    const currentLine = lines[range.end.line] ?? "";
    const followingCharacter = currentLine[range.end.character];
    if (followingCharacter === " " || followingCharacter === "\t") {
      editRange = {
        start: range.start,
        end: { ...range.end, character: range.end.character + 1 },
      };
    }
  }
  return {
    code: policy.code,
    title: policy.title,
    safety: policy.safety,
    fixAllEligible: policy.fixAllEligible,
    edit: { range: editRange, newText: policy.newText },
  };
}
