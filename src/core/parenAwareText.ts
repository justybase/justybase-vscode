/**
 * Lightweight paren/quote aware helpers for SQL text fragments.
 */

export function splitCommaSeparatedTopLevel(section: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    const prev = index > 0 ? section[index - 1] : "";

    if (!inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (!inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth = Math.max(0, depth - 1);
      } else if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

/**
 * Returns true when `text` ends while still inside an unclosed `(` opened at `openParenIndex`.
 */
export function endsInsideUnclosedParen(
  text: string,
  openParenIndex: number,
): boolean {
  if (openParenIndex < 0 || openParenIndex >= text.length) {
    return false;
  }
  if (text[openParenIndex] !== "(") {
    return false;
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let index = openParenIndex; index < text.length; index += 1) {
    const char = text[index];
    const prev = index > 0 ? text[index - 1] : "";

    if (!inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
  }

  return depth > 0;
}
