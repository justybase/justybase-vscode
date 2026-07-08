import { netezzaSqlAuthoring } from "../../dialects/netezza/sql/authoring";
import type { DocumentParseSession, DocumentParseRequest } from "../documentParseSession";

export const CREATE_PROCEDURE_PATTERN =
  /\bCREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i;

const fallbackResultCache = new Map<string, boolean>();

export function isProcedureSql(sql: string): boolean {
  return CREATE_PROCEDURE_PATTERN.test(sql);
}

export function beginProcedureRuleEvaluation(): void {
  fallbackResultCache.clear();
}

export function endProcedureRuleEvaluation(): void {
  fallbackResultCache.clear();
}

/** Pre-compute regex-fallback state once per quality-rule pass. */
export function warmProcedureParseGate(
  sql: string,
  session?: DocumentParseSession,
  request?: Pick<
    DocumentParseRequest,
    "documentUri" | "documentVersion" | "databaseKind"
  >,
): void {
  if (isProcedureSql(sql)) {
    resolveProcedureRegexFallback(sql, session, request);
  }
}

/**
 * When Chevrotain parses a procedure without actionable errors, structural NZP
 * regex rules are skipped in favor of PAR/SQL037-040 CST diagnostics.
 */
export function shouldUseProcedureRegexFallback(
  sql: string,
  session?: DocumentParseSession,
  request?: Pick<
    DocumentParseRequest,
    "documentUri" | "documentVersion" | "databaseKind"
  >,
): boolean {
  if (!isProcedureSql(sql)) {
    return true;
  }

  return resolveProcedureRegexFallback(sql, session, request);
}

function resolveProcedureRegexFallback(
  sql: string,
  session?: DocumentParseSession,
  request?: Pick<
    DocumentParseRequest,
    "documentUri" | "documentVersion" | "databaseKind"
  >,
): boolean {
  const cached = fallbackResultCache.get(sql);
  if (cached !== undefined) {
    return cached;
  }

  let useFallback: boolean;
  try {
    const parseResult =
      session && request
        ? session.getParseResult({
            ...request,
            sql,
            validationProfile: netezzaSqlAuthoring.validation,
          })
        : (() => {
            const { parseSqlStatements } =
              require("../parsingRuntime") as typeof import("../parsingRuntime");
            return parseSqlStatements({
              sql,
              validationProfile: netezzaSqlAuthoring.validation,
            });
          })();
    useFallback =
      parseResult.actionableParserErrors.length > 0 ||
      parseResult.cst === undefined;
  } catch {
    useFallback = true;
  }

  fallbackResultCache.set(sql, useFallback);
  return useFallback;
}
