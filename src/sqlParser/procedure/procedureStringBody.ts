import type { CstNode, IRecognitionException } from "chevrotain";
import {
  parseSqlStatements,
  type SqlParsingRuntime,
} from "../parsingRuntime";

const STRING_BODY_SHELL_PREFIX =
  "CREATE PROCEDURE STR_BODY_WRAPPER() RETURNS INT4 LANGUAGE NZPLSQL AS BEGIN_PROC\n";
const STRING_BODY_SHELL_SUFFIX = "\nEND_PROC;";

export function decodeSqlStringLiteral(image: string): string {
  const quoted = image.trim();
  if (!quoted.startsWith("'") || !quoted.endsWith("'")) {
    return quoted;
  }
  return quoted.slice(1, -1).replace(/''/g, "'");
}

export function wrapProcedureStringBody(decodedBody: string): string {
  return `${STRING_BODY_SHELL_PREFIX}${decodedBody}${STRING_BODY_SHELL_SUFFIX}`;
}

export function getStringBodyOffsetShift(quoteContentStart: number): number {
  return quoteContentStart - STRING_BODY_SHELL_PREFIX.length;
}

export function findCstRule(node: CstNode, ruleName: string): CstNode | undefined {
  if (node.name === ruleName) {
    return node;
  }
  for (const children of Object.values(node.children ?? {})) {
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (typeof child === "object" && child !== null && "name" in child) {
        const found = findCstRule(child as CstNode, ruleName);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export function parseWrappedProcedureStringBody(
  decodedBody: string,
  runtime: SqlParsingRuntime,
): {
  beginProcBody?: CstNode;
  parserErrors: IRecognitionException[];
} {
  const parseResult = parseSqlStatements({
    sql: wrapProcedureStringBody(decodedBody),
    runtime,
  });
  const statementsNode = parseResult.cst;
  const beginProcBody = statementsNode
    ? findCstRule(statementsNode, "beginProcBody")
    : undefined;
  return {
    beginProcBody,
    parserErrors: parseResult.actionableParserErrors,
  };
}
