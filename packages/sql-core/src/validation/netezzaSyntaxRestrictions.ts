import type { IToken } from "chevrotain";
import type { ValidationError } from "./types";

/**
 * Token-level legality checks for constructs that the audited Netezza
 * compatibility profile rejects even though the permissive surface grammar can
 * still parse them. These produce ordinary validation errors, so both
 * `validate()` and the standalone `runPreParseChecks()` (used by the
 * conformance adapter) report them.
 *
 * Every rule here is backed by live Netezza evidence recorded in
 * JustyBase.SqlConformance (`dialects/netezza/live/**`, oracleVerified cases):
 * - FETCH FIRST/NEXT is rejected (use LIMIT); NZS002.
 * - A standalone OUTER JOIN without LEFT/RIGHT/FULL is rejected; NZS003.
 * - DROP ... IF EXISTS is rejected; NZS004.
 * - ALTER TABLE ... DROP <column> requires RESTRICT or CASCADE; NZS005.
 * - Multi-row VALUES is rejected (one INSERT per row); NZS006.
 */

function errorAt(code: string, message: string, token: IToken): ValidationError {
  const startLine = token.startLine ?? 1;
  const startColumn = token.startColumn ?? 1;
  const endLine = token.endLine ?? startLine;
  const endColumn =
    token.endColumn ?? startColumn + (token.image?.length ?? 1);
  return {
    message,
    severity: "error",
    position: {
      startLine,
      startColumn,
      endLine,
      endColumn,
      offset: token.startOffset ?? 0,
    },
    code,
  };
}

function tokenName(token: IToken | undefined): string | undefined {
  return token?.tokenType?.name;
}

const JOIN_TYPE_BEFORE_OUTER = new Set(["Left", "Right", "Full"]);

export function detectNetezzaSyntaxRestrictions(
  tokens: readonly IToken[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokenName(tokens[index]);
    const image = tokens[index].image.toUpperCase();
    if (image === "INTERVAL" && tokenName(tokens[index + 1]) === "StringLiteral"
      && /^(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)$/.test(tokens[index + 2]?.image.toUpperCase() ?? "")) {
      errors.push(errorAt("NZS007", "Netezza interval units belong inside the interval literal.", tokens[index + 2]));
    }
    if (image === "TIMESTAMPTZ" && (tokenName(tokens[index - 1]) === "As"
      || tokenName(tokens[index + 1]) === "StringLiteral")) {
      errors.push(errorAt("NZS008", "TIMESTAMPTZ literals and casts are not supported by Netezza.", tokens[index]));
    }
    if (name === "Create" && tokenName(tokens[index + 1]) === "Materialized") {
      let depth = 0;
      let queryDepth: number | undefined;
      let hasSource = false;
      let hasWhere = false;
      for (let scan = index + 2; scan < tokens.length && tokenName(tokens[scan]) !== "Semicolon"; scan++) {
        const current = tokenName(tokens[scan]);
        if (current === "LParen") depth++;
        if (current === "RParen") depth--;
        if (current === "Select" && queryDepth === undefined) queryDepth = depth;
        if (depth === queryDepth && current === "From") hasSource = true;
        if (depth === queryDepth && current === "Where") hasWhere = true;
      }
      if (!hasSource || hasWhere) errors.push(errorAt("NZS009",
        "Netezza materialized views require a source relation and do not support a WHERE filter.", tokens[index]));
    }
    if (name === "Merge") {
      let depth = 0;
      let matched: boolean | undefined;
      for (let scan = index + 1; scan < tokens.length && tokenName(tokens[scan]) !== "Semicolon"; scan++) {
        const current = tokenName(tokens[scan]);
        if (current === "LParen") depth++;
        if (current === "RParen") depth--;
        if (depth !== 0) continue;
        if (current === "When") matched = tokenName(tokens[scan + 1]) !== "Not";
        if (matched !== undefined && current === "Then") {
          const action = tokenName(tokens[scan + 1]);
          if (matched && action === "Insert" || !matched && (action === "Update" || action === "Delete"))
            errors.push(errorAt("NZS010", "This MERGE action is not valid for its MATCHED branch.", tokens[scan + 1]));
        }
        if (matched !== undefined && current === "Where")
          errors.push(errorAt("NZS011", "Netezza does not support a WHERE suffix on MERGE actions.", tokens[scan]));
      }
    }

    // FETCH FIRST / FETCH NEXT
    if (name === "Fetch") {
      const next = tokenName(tokens[index + 1]);
      if (next === "First" || next === "Next") {
        errors.push(
          errorAt(
            "NZS002",
            "FETCH FIRST/NEXT is not accepted by the audited Netezza compatibility profile; use LIMIT.",
            tokens[index],
          ),
        );
      }
    }

    // Standalone OUTER JOIN (no LEFT/RIGHT/FULL before OUTER)
    if (
      name === "Outer" &&
      tokenName(tokens[index + 1]) === "Join" &&
      !JOIN_TYPE_BEFORE_OUTER.has(tokenName(tokens[index - 1]) ?? "")
    ) {
      errors.push(
        errorAt(
          "NZS003",
          "Standalone OUTER JOIN is not valid Netezza syntax; use LEFT, RIGHT, or FULL OUTER JOIN.",
          tokens[index],
        ),
      );
    }

    // DROP ... IF EXISTS
    if (name === "Drop") {
      for (let scan = index + 1; scan < tokens.length; scan += 1) {
        const scanName = tokenName(tokens[scan]);
        if (scanName === "Semicolon") break;
        if (
          scanName === "If" &&
          tokenName(tokens[scan + 1]) === "Exists"
        ) {
          errors.push(
            errorAt(
              "NZS004",
              "DROP ... IF EXISTS is not valid Netezza syntax.",
              tokens[scan],
            ),
          );
          break;
        }
      }
    }

    // ALTER TABLE ... DROP <column> requires RESTRICT or CASCADE
    if (
      name === "Alter" &&
      tokenName(tokens[index + 1]) === "Table"
    ) {
      let dropIndex = -1;
      let hasBehavior = false;
      for (let scan = index + 2; scan < tokens.length; scan += 1) {
        const scanName = tokenName(tokens[scan]);
        if (scanName === "Semicolon") break;
        if (scanName === "Drop" && dropIndex === -1) {
          dropIndex = scan;
          continue;
        }
        if (scanName === "Cascade" || scanName === "Restrict") {
          hasBehavior = true;
        }
      }
      if (dropIndex !== -1) {
        const droppedWhat = tokenName(tokens[dropIndex + 1]);
        const isColumnDrop = droppedWhat !== "Constraint";
        if (isColumnDrop && !hasBehavior) {
          errors.push(
            errorAt(
              "NZS005",
              "ALTER TABLE ... DROP COLUMN requires RESTRICT or CASCADE in Netezza.",
              tokens[dropIndex],
            ),
          );
        }
      }
    }

    // Multi-row VALUES
    if (name === "Values" && tokenName(tokens[index + 1]) === "LParen") {
      let depth = 0;
      let scan = index + 1;
      for (; scan < tokens.length; scan += 1) {
        const scanName = tokenName(tokens[scan]);
        if (scanName === "LParen") depth += 1;
        else if (scanName === "RParen") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (
        tokenName(tokens[scan + 1]) === "Comma" &&
        tokenName(tokens[scan + 2]) === "LParen"
      ) {
        errors.push(
          errorAt(
            "NZS006",
            "Multi-row VALUES is not supported by Netezza; use one INSERT per row.",
            tokens[index],
          ),
        );
      }
    }
  }

  return errors;
}
