import type { IToken } from "chevrotain";
import { getAvailableTokenLocation } from "./tokenLocation";
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
 * - DROP ... IF EXISTS before the object name is rejected; NZS004. The
 *   trailing `DROP TABLE <name>[, <name>] IF EXISTS` form is accepted (also
 *   for `DB..T` and keyword table names), while a trailing IF EXISTS on
 *   DROP VIEW / DROP SEQUENCE is rejected (all live-verified).
 * - ALTER TABLE ... DROP <column> and DROP CONSTRAINT require RESTRICT or CASCADE; NZS005.
 * - GRANT/REVOKE ... ON TABLE names the object class, so a relation name there is rejected; PAR003.
 * - Multi-row VALUES is rejected (one INSERT per row); NZS006.
 * - GENERATE [EXPRESS] STATISTICS accepts only the optional `ON <table>` target;
 *   `FOR TABLE` is rejected and the deprecated EXPRESS form requires ON; NZS008.
 * - EXPLAIN accepts at most one of VERBOSE, DISTRIBUTION, PLANTEXT, or PLANGRAPH; NZS012.
 * - A WITH clause may only be followed by SELECT or `(`; WITH ... INSERT is
 *   rejected (live: found "INSERT" expecting SELECT or `(`); NZS013. The
 *   INSERT ... WITH ... form (CTE in query position) stays accepted.
 * - SERIAL and BIGSERIAL are rejected as CREATE TABLE column types; NZS014.
 * - CLOB(n)/NCLOB(n) with a length and a bare BLOB are rejected as CREATE
 *   TABLE column types; NZS015.
 * - In INSERT ... WITH the CTE name requires AS before its subquery; a
 *   parenthesized query without AS is rejected (live: found "SELECT"
 *   expecting an identifier); NZS016. `WITH name [(cols)] AS (...)` stays
 *   accepted.
 * - A wildcard select item cannot carry an alias; `SELECT * AS x` is rejected
 *   (live: found "AS" expecting a keyword); NZS017. `COUNT(*) AS x` and
 *   expression aliases such as `a * b AS x` stay accepted.
 * - A procedure reference in DROP/COMMENT ON requires its argument-type
 *   signature; `DROP PROCEDURE p;` is rejected (live: found ";" expecting
 *   '(') and `COMMENT ON PROCEDURE p IS '...'` is rejected (live: found "IS"
 *   expecting '('); NZS018. The parens may be empty. An unterminated
 *   statement stays quiet so typing is not flagged before `(` is typed.
 * - Unquoted PUBLIC is a keyword wherever Netezza expects an identifier
 *   (relation, column, alias, schema, procedure, view, sequence, synonym);
 *   NZS019. Live: found "PUBLIC" ... expecting an identifier found a keyword.
 *   `DB."PUBLIC"`/`"PUBLIC".T` stay accepted, and GRANT/REVOKE grantees are
 *   the only unquoted PUBLIC positions live accepts (`TO PUBLIC`,
 *   `FROM PUBLIC`).
 * - CREATE EXTERNAL TABLE ... SAMEAS requires a USING (...) clause; NZS020.
 *   Live: found ";" ... expecting USING.
 * - EXPLAIN supports only DELETE/INSERT/SELECT/UPDATE/WITH statements; NZS021.
 *   Live: found "CREATE" ... expecting DELETE or INSERT or SELECT or UPDATE or WITH.
 * - GRANT/REVOKE with an object class (TABLE, SCHEMA) require the role clause
 *   immediately after the class; a relation/schema name is rejected (PAR003).
 */

function errorAt(code: string, message: string, token: IToken): ValidationError {
  const startLine = token.startLine ?? 1;
  const startColumn = token.startColumn ?? 1;
  const endLine = token.endLine ?? startLine;
  // Chevrotain's endColumn is the 1-based column of the last character, while
  // validation positions use an exclusive end. Add one so diagnostics cover the
  // whole token instead of stopping on its first character.
  const endColumn =
    getAvailableTokenLocation(token.endColumn) !== undefined
      ? token.endColumn! + 1
      : startColumn + (token.image?.length ?? 1);
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
const SELECT_ITEM_START = new Set(["Select", "Comma", "Distinct", "All", "Unique"]);
const EXPLAIN_OPTIONS: Record<string, true> = {
  Verbose: true,
  Distribution: true,
  Plantext: true,
  Plangraph: true,
};

/**
 * True when the `*` at `index` is a select-list wildcard rather than a
 * multiplication operator. A wildcard starts a select item (after SELECT, a
 * comma, DISTINCT/ALL/UNIQUE, or TOP's row count) or follows a qualifier dot.
 */
function isWildcardProjection(tokens: readonly IToken[], index: number): boolean {
  const previousName = tokenName(tokens[index - 1]);
  if (previousName === "Dot") return true;
  if (previousName && SELECT_ITEM_START.has(previousName)) return true;
  // TOP <count> * ... (including DISTINCT TOP <count> * ...)
  return previousName === "Integer" && tokenName(tokens[index - 2]) === "Top";
}

function isImplicitAliasToken(token: IToken | undefined): boolean {
  const name = tokenName(token);
  return name === "Identifier" || name === "QuotedIdentifier";
}

export function detectNetezzaSyntaxRestrictions(
  tokens: readonly IToken[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokenName(tokens[index]);
    const image = tokens[index].image.toUpperCase();
    // A wildcard select item cannot be aliased, with or without AS. Live
    // Netezza rejects both `SELECT * AS SOME_ALIAS` (at AS) and
    // `SELECT * SOME_ALIAS` / `SELECT T.* SOME_ALIAS` (at the alias).
    // The wildcard-position check keeps `COUNT(*) AS x` and `a * b AS x`
    // accepted.
    const next = tokens[index + 1];
    const aliasToken = tokenName(next) === "As"
      ? next
      : isImplicitAliasToken(next) ? next : undefined;
    if (name === "Multiply" && isWildcardProjection(tokens, index) && aliasToken) {
      errors.push(
        errorAt(
          "NZS017",
          "Netezza does not accept an alias after '*'; a wildcard cannot have an alias. Remove the alias.",
          aliasToken,
        ),
      );
    }
    if (name === "Explain"
      && EXPLAIN_OPTIONS[tokenName(tokens[index + 1]) ?? ""] === true
      && EXPLAIN_OPTIONS[tokenName(tokens[index + 2]) ?? ""] === true) {
      errors.push(errorAt(
        "NZS012",
        "Netezza EXPLAIN accepts at most one option.",
        tokens[index + 2],
      ));
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
    if (name === "Explain") {
      let statementIndex = index + 1;
      while (EXPLAIN_OPTIONS[tokenName(tokens[statementIndex]) ?? ""] === true) {
        statementIndex += 1;
      }
      if (tokenName(tokens[statementIndex]) === "Create") {
        errors.push(errorAt(
          "NZS021",
          "Netezza EXPLAIN supports only SELECT, INSERT, UPDATE, DELETE, or WITH statements.",
          tokens[statementIndex],
        ));
      }
    }
    if (name === "Create" && tokenName(tokens[index + 1]) === "External"
      && tokenName(tokens[index + 2]) === "Table") {
      let sameAsIndex: number | undefined;
      let hasUsing = false;
      for (let scan = index + 3; scan < tokens.length && tokenName(tokens[scan]) !== "Semicolon"; scan++) {
        const current = tokenName(tokens[scan]);
        if (current === "SameAs") sameAsIndex = scan;
        if (current === "Using") hasUsing = true;
      }
      if (sameAsIndex !== undefined && !hasUsing) {
        errors.push(errorAt(
          "NZS020",
          "Netezza requires USING (...) after CREATE EXTERNAL TABLE ... SAMEAS.",
          tokens[sameAsIndex],
        ));
      }
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
    //
    // Netezza accepts IF EXISTS only after the target list of a DROP TABLE:
    // `DROP TABLE <name> IF EXISTS` (Netezza Performance Server SQL command
    // reference, DROP TABLE). The leading form `DROP TABLE IF EXISTS <name>`
    // and a trailing IF EXISTS on any other DROP object class stay invalid.
    if (name === "Drop") {
      const objectWords: string[] = [];
      let sawTarget = false;
      for (let scan = index + 1; scan < tokens.length; scan += 1) {
        const scanName = tokenName(tokens[scan]);
        if (scanName === undefined || scanName === "Semicolon") break;
        if (scanName === "If") {
          if (tokenName(tokens[scan + 1]) !== "Exists") break;
          const trailingTableIfExists =
            sawTarget && objectWords.length === 1 && objectWords[0] === "Table";
          if (!trailingTableIfExists) {
            errors.push(
              errorAt(
                "NZS004",
                sawTarget
                  ? "Only DROP TABLE accepts a trailing IF EXISTS in Netezza."
                  : "Netezza does not accept IF EXISTS before the object name; use DROP TABLE <name> IF EXISTS.",
                tokens[scan],
              ),
            );
          }
          break;
        }
        if (
          scanName === "Identifier" ||
          scanName === "QuotedIdentifier" ||
          scanName === "NumberLiteral" ||
          // Anything after DROP TABLE names the target, including keyword
          // names such as VALUE, TYPE or KEY (live-verified accepted).
          (objectWords.length === 1 && objectWords[0] === "Table")
        ) {
          sawTarget = true;
          continue;
        }
        if (!sawTarget && objectWords.length < 2) {
          objectWords.push(scanName);
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
        // `ALTER COLUMN <c> DROP DEFAULT` is a column-property change, not a
        // column/constraint drop. Live Netezza 11.2.2.1 accepts it without a
        // RESTRICT/CASCADE suffix; only the ALTER TABLE action DROP needs one.
        const isAlterColumnAction = tokens
          .slice(index + 2, dropIndex)
          .some((token) => tokenName(token) === "Alter");
        if (!hasBehavior && !isAlterColumnAction) {
          const what =
            tokenName(tokens[dropIndex + 1]) === "Constraint"
              ? "DROP CONSTRAINT"
              : "DROP COLUMN";
          errors.push(
            errorAt(
              "NZS005",
              `ALTER TABLE ... ${what} requires RESTRICT or CASCADE in Netezza.`,
              tokens[dropIndex],
            ),
          );
        }
      }
    }

    // GENERATE [EXPRESS] STATISTICS accepts only the optional ON <table> target.
    // Live Netezza rejects `FOR TABLE` ("found FOR ... expecting ON") and
    // requires ON for the deprecated EXPRESS form; the bare non-EXPRESS form
    // covers every table in the current database and is accepted.
    if (name === "Generate") {
      let scan = index + 1;
      let express = false;
      if (tokenName(tokens[scan]) === "Express") {
        express = true;
        scan += 1;
      }
      if (tokenName(tokens[scan]) === "Statistics") {
        scan += 1;
        const nextName = tokenName(tokens[scan]);
        const atEnd = nextName === undefined || nextName === "Semicolon";
        if (nextName !== "On" && !(atEnd && !express)) {
          errors.push(
            errorAt(
              "NZS008",
              express
                ? "GENERATE EXPRESS STATISTICS requires ON and a table name in Netezza."
                : "Netezza does not accept GENERATE STATISTICS FOR TABLE; use ON <table>.",
              tokens[scan] ?? tokens[index],
            ),
          );
        }
      }
    }

    // GRANT/REVOKE ... ON TABLE <name>: live Netezza accepts `ON TABLE TO u` (object class) only.
    if (name === "Grant" || name === "Revoke") {
      const roleClause = name === "Grant" ? "TO" : "FROM";
      for (let scan = index + 1; scan < tokens.length; scan += 1) {
        const scanName = tokenName(tokens[scan]);
        if (scanName === "Semicolon") break;
        if (tokens[scan].image.toUpperCase() !== "ON") continue;
        const next = tokens[scan + 2];
        const objectClass = tokenName(tokens[scan + 1]);
        if (
          (objectClass === "Table" || objectClass === "Schema") &&
          next !== undefined &&
          tokenName(next) !== "Semicolon" &&
          next.image.toUpperCase() !== roleClause
        ) {
          errors.push(
            errorAt(
              "PAR003",
              `Expected ${roleClause} after the object class '${tokens[scan + 1].image.toUpperCase()}'.`,
              next,
            ),
          );
        }
        break;
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

  // WITH ... INSERT: live Netezza accepts only SELECT or `(` after the CTE
  // list (`found "INSERT" ... expecting SELECT or '('`). The INSERT ... WITH
  // form (CTE in query position) and nested WITHs inside CTE bodies stay
  // accepted. Token-level scan: at statement level (depth 0), once With has
  // been seen, a bare Insert before any Select is the rejected shape.
  {
    let depth = 0;
    let withAtDepthZero = false;
    for (let scan = 0; scan < tokens.length; scan += 1) {
      const current = tokenName(tokens[scan]);
      if (current === "LParen") {
        depth += 1;
        continue;
      }
      if (current === "RParen") {
        depth -= 1;
        continue;
      }
      if (depth !== 0) continue;
      if (current === "Semicolon") {
        withAtDepthZero = false;
        continue;
      }
      if (current === "With") {
        withAtDepthZero = true;
        continue;
      }
      if (withAtDepthZero && current === "Select") {
        withAtDepthZero = false;
        continue;
      }
      if (withAtDepthZero && current === "Insert") {
        errors.push(errorAt(
          "NZS013",
          "Netezza does not accept INSERT after a WITH clause; only SELECT or '(' may follow WITH.",
          tokens[scan],
        ));
        withAtDepthZero = false;
      }
    }
  }

  // INSERT ... WITH ... : the CTE name requires AS before its subquery
  // (live: found "SELECT" expecting an identifier); NZS016. The grammar's
  // insertCteDefinition leaves AS optional, so the no-AS shape parses and is
  // rejected here. Only the evidenced shape is flagged: a depth-0 CTE name
  // directly followed by a parenthesized query (`WITH name (SELECT|WITH`
  // ...)`). `WITH name [(cols)] AS (...)` stays accepted.
  {
    let depth = 0;
    let insertAtDepthZero = false;
    let cteHeader = false;
    let expectCteName = false;
    for (let scan = 0; scan < tokens.length; scan += 1) {
      const current = tokenName(tokens[scan]);
      if (current === "LParen") {
        depth += 1;
        continue;
      }
      if (current === "RParen") {
        depth -= 1;
        continue;
      }
      if (depth !== 0) continue;
      if (current === "Semicolon") {
        insertAtDepthZero = false;
        cteHeader = false;
        expectCteName = false;
        continue;
      }
      if (current === "Insert") {
        insertAtDepthZero = true;
        cteHeader = false;
        expectCteName = false;
        continue;
      }
      if (current === "With" && insertAtDepthZero) {
        cteHeader = true;
        expectCteName = true;
        continue;
      }
      if (!cteHeader) continue;
      if (current === "Select") {
        cteHeader = false;
        expectCteName = false;
        continue;
      }
      if (current === "Comma") {
        expectCteName = true;
        continue;
      }
      if (expectCteName && current === "Identifier") {
        expectCteName = false;
        if (
          tokenName(tokens[scan + 1]) === "LParen" &&
          (tokenName(tokens[scan + 2]) === "Select" ||
            tokenName(tokens[scan + 2]) === "With")
        ) {
          errors.push(errorAt(
            "NZS016",
            "The CTE name in INSERT ... WITH requires AS before its subquery.",
            tokens[scan + 1],
          ));
        }
        continue;
      }
      if (current !== "Recursive") expectCteName = false;
    }
  }

  // SERIAL/BIGSERIAL are not accepted at all (NZS014); CLOB/NCLOB accept no
  // length argument and bare BLOB is not a column type (NZS015). Narrowly
  // scoped to the parenthesized definition list of a CREATE TABLE: a list
  // opening on WITH/SELECT is a CTAS query and is skipped, and only words
  // directly inside the list are inspected, so nested expressions and
  // constraint parens are untouched. A word right after `(` or `,` is the
  // column name (or a CTAS output name), never the type.
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenName(tokens[index]) !== "Create") continue;
    let tableIdx = index + 1;
    while (
      tableIdx < tokens.length &&
      ["Temp", "Temporary", "Global", "External"].includes(
        tokenName(tokens[tableIdx]) ?? "",
      )
    ) {
      tableIdx += 1;
    }
    if (tokenName(tokens[tableIdx]) !== "Table") continue;
    let openIdx = -1;
    for (let scan = tableIdx + 1; scan < tokens.length; scan += 1) {
      const scanName = tokenName(tokens[scan]);
      if (scanName === "Semicolon") break;
      if (scanName === "LParen") {
        openIdx = scan;
        break;
      }
    }
    if (openIdx === -1) continue;
    const firstName = tokenName(tokens[openIdx + 1]);
    if (firstName === "With" || firstName === "Select") continue;
    let listDepth = 0;
    for (let scan = openIdx; scan < tokens.length; scan += 1) {
      const scanName = tokenName(tokens[scan]);
      if (scanName === "Semicolon") break;
      if (scanName === "LParen") {
        listDepth += 1;
        continue;
      }
      if (scanName === "RParen") {
        listDepth -= 1;
        if (listDepth === 0) break;
        continue;
      }
      if (listDepth !== 1) continue;
      const image = tokens[scan].image.toUpperCase();
      const prev = tokens[scan - 1];
      const prevName = tokenName(prev);
      const inNamePosition =
        prevName === "LParen" ||
        prevName === "Comma" ||
        (prev?.image.toUpperCase() === "CONSTRAINT");
      if (inNamePosition) continue;
      if (
        tokenName(tokens[scan]) === "Identifier" &&
        (image === "SERIAL" || image === "BIGSERIAL")
      ) {
        errors.push(errorAt(
          "NZS014",
          "SERIAL and BIGSERIAL are not valid Netezza column types.",
          tokens[scan],
        ));
        continue;
      }
      if (
        tokenName(tokens[scan]) === "Identifier" &&
        (image === "CLOB" || image === "NCLOB") &&
        tokenName(tokens[scan + 1]) === "LParen"
      ) {
        errors.push(errorAt(
          "NZS015",
          "Netezza does not accept a length argument on CLOB/NCLOB.",
          tokens[scan],
        ));
        continue;
      }
      if (
        tokenName(tokens[scan]) === "Identifier" &&
        image === "BLOB" &&
        tokenName(tokens[scan + 1]) !== "LParen"
      ) {
        errors.push(errorAt(
          "NZS015",
          "BLOB is not a valid Netezza column type.",
          tokens[scan],
        ));
      }
    }
  }

  // DROP PROCEDURE / COMMENT ON PROCEDURE require the argument-type
  // signature: live Netezza resolves a routine by name plus signature.
  for (let index = 0; index < tokens.length; index += 1) {
    let procIdx = -1;
    if (
      tokenName(tokens[index]) === "Drop" &&
      tokenName(tokens[index + 1]) === "Procedure"
    ) {
      procIdx = index + 2;
    } else if (
      tokenName(tokens[index]) === "Comment" &&
      tokenName(tokens[index + 1]) === "On" &&
      tokenName(tokens[index + 2]) === "Procedure"
    ) {
      procIdx = index + 3;
    }
    if (procIdx === -1) continue;
    // Optional leading IF EXISTS (accepted positionally here; placement is
    // validated by the NZS004 rule) and the qualified routine name.
    if (
      tokenName(tokens[procIdx]) === "If" &&
      tokenName(tokens[procIdx + 1]) === "Exists"
    ) {
      procIdx += 2;
    }
    let scan = procIdx;
    // The permissive grammar accepts keyword tokens in a qualified routine
    // name (e.g. TESTDB.PUBLIC.P_COMMENT); unquoted PUBLIC is still reported
    // separately by NZS019 because Netezza rejects it as an identifier.
    // Anything except structural tokens counts as part of the routine name.
    const nameTerminator = new Set([
      "LParen",
      "RParen",
      "Semicolon",
      "Comma",
      "Is",
      "If",
      "Exists",
      "StringLiteral",
    ]);
    while (
      scan < tokens.length &&
      !nameTerminator.has(tokenName(tokens[scan]) ?? "")
    ) {
      scan += 1;
    }
    if (scan === procIdx) continue;
    if (tokenName(tokens[scan]) === "LParen") continue;
    // Unterminated input stays quiet: the signature may still be typed.
    let end = scan;
    while (
      end < tokens.length &&
      tokenName(tokens[end]) !== "Semicolon"
    ) {
      end += 1;
    }
    if (end >= tokens.length) continue;
    errors.push(
      errorAt(
        "NZS018",
        "Netezza identifies a procedure by name plus its argument-type signature; add parentheses, e.g. `MY_PROC()`.",
        tokens[scan],
      ),
    );
  }

  // Unquoted PUBLIC is a keyword, not an identifier. Live Netezza rejects it
  // in every identifier position (relation, column, alias, schema, routine,
  // view, sequence, synonym) with `expecting an identifier found a keyword`.
  // GRANT/REVOKE grantees are the only accepted unquoted use, so allow a
  // PUBLIC token that follows the grantee clause keyword (TO/FROM) of its
  // statement and quote everything else.
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenName(tokens[index]) !== "Public") continue;
    let statementStart = index;
    while (
      statementStart > 0 &&
      tokenName(tokens[statementStart - 1]) !== "Semicolon"
    ) {
      statementStart -= 1;
    }
    // Track the most recent GRANT/REVOKE verb and its role clause so a grantee
    // inside a procedural body (`BEGIN GRANT ... TO PUBLIC; END`) is allowed
    // just like a top-level grant.
    let verb: "Grant" | "Revoke" | undefined;
    let granteeClauseSeen = false;
    for (let scan = statementStart; scan < index; scan += 1) {
      const scanName = tokenName(tokens[scan]);
      if (scanName === "Semicolon") {
        verb = undefined;
        granteeClauseSeen = false;
      } else if (scanName === "Grant") {
        verb = "Grant";
        granteeClauseSeen = false;
      } else if (scanName === "Revoke") {
        verb = "Revoke";
        granteeClauseSeen = false;
      } else if (
        (verb === "Grant" && scanName === "To") ||
        (verb === "Revoke" && scanName === "From")
      ) {
        granteeClauseSeen = true;
      }
    }
    if (granteeClauseSeen) continue;
    errors.push(
      errorAt(
        "NZS019",
        'PUBLIC is a Netezza keyword and cannot be used as an unquoted identifier; write "PUBLIC" instead.',
        tokens[index],
      ),
    );
  }

  return errors;
}
