import type { TextDocument } from "vscode-languageserver-textdocument";

export function getTextBeforeCursor(
  document: TextDocument,
  offset: number,
): string {
  const text = document.getText();
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return text.substring(lineStart, offset);
}

export function findFunctionCall(
  textBeforeCursor: string,
): { functionName: string; argumentPosition: number } | undefined {
  const functionPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  let lastMatch: { name: string; openParenIndex: number } | undefined;
  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(textBeforeCursor)) !== null) {
    lastMatch = {
      name: match[1],
      openParenIndex: match.index + match[0].length - 1,
    };
  }

  if (!lastMatch) {
    return undefined;
  }

  const afterOpenParen = textBeforeCursor.substring(
    lastMatch.openParenIndex + 1,
  );

  let depth = 1;
  let argumentPosition = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < afterOpenParen.length; i++) {
    const char = afterOpenParen[i];

    if (
      (char === "'" || char === '"') &&
      (i === 0 || afterOpenParen[i - 1] !== "\\")
    ) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) {
        return undefined;
      }
    } else if (char === "," && depth === 1) {
      argumentPosition++;
    }
  }

  if (depth > 0) {
    return {
      functionName: lastMatch.name,
      argumentPosition,
    };
  }

  return undefined;
}
