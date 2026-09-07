import type { CstNode, IRecognitionException } from "chevrotain";
import { parseNetezzaSqlStatements, type NetezzaSqlParseResult } from "../parser/runtime";

const STRING_BODY_SHELL_PREFIX = "CREATE PROCEDURE STR_BODY_WRAPPER() RETURNS INT4 LANGUAGE NZPLSQL AS BEGIN_PROC\n";
const STRING_BODY_SHELL_SUFFIX = "\nEND_PROC;";

export function decodeSqlStringLiteral(image: string): string {
  const quoted = image.trim();
  return quoted.startsWith("'") && quoted.endsWith("'") ? quoted.slice(1, -1).replace(/''/g, "'") : quoted;
}

export function wrapProcedureStringBody(decodedBody: string): string {
  return `${STRING_BODY_SHELL_PREFIX}${decodedBody}${STRING_BODY_SHELL_SUFFIX}`;
}

export function getStringBodyOffsetShift(quoteContentStart: number): number {
  return quoteContentStart - STRING_BODY_SHELL_PREFIX.length;
}

export function findCstRule(node: CstNode, ruleName: string): CstNode | undefined {
  if (node.name === ruleName) return node;
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

export function parseWrappedProcedureStringBody(decodedBody: string): {
  beginProcBody?: CstNode;
  parserErrors: IRecognitionException[];
} {
  const result: NetezzaSqlParseResult = parseNetezzaSqlStatements({ sql: wrapProcedureStringBody(decodedBody) });
  return {
    beginProcBody: result.cst ? findCstRule(result.cst, "beginProcBody") : undefined,
    parserErrors: result.actionableParserErrors,
  };
}
