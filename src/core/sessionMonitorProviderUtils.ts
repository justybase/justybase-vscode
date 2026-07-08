import type { ExtensionContext } from "vscode";
import type { ConnectionManager } from "./connectionManager";
import { queryResultToRows, runQueryRaw } from "./queryRunner";

export interface SessionMonitorResources {
  gra: unknown[];
  systemUtil: unknown[];
  sysUtilSummary: unknown;
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function normalizeDatabaseFilter(
  database: string | undefined,
): string | undefined {
  const normalized = database?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function validatePositiveIntegerSessionId(
  sessionId: number,
  dialectLabel = "database",
): void {
  if (
    !Number.isFinite(sessionId) ||
    sessionId <= 0 ||
    !Number.isInteger(sessionId)
  ) {
    throw new Error(`Invalid ${dialectLabel} session ID: ${sessionId}`);
  }
}

export async function runSessionMonitorQuery<T extends Record<string, unknown>>(
  context: unknown,
  connectionManager: ConnectionManager,
  sql: string,
  rowLimit = 1000,
): Promise<T[]> {
  const result = await runQueryRaw(
    context as ExtensionContext,
    sql,
    true,
    connectionManager,
    undefined,
    undefined,
    undefined,
    undefined,
    rowLimit,
    false,
  );
  if (!result?.data) {
    return [];
  }
  return queryResultToRows<T>(result);
}

export async function executeSessionMonitorStatement(
  context: unknown,
  connectionManager: ConnectionManager,
  sql: string,
): Promise<void> {
  await runQueryRaw(
    context as ExtensionContext,
    sql,
    true,
    connectionManager,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
    false,
  );
}

export function emptySessionMonitorResources(): SessionMonitorResources {
  return {
    gra: [],
    systemUtil: [],
    sysUtilSummary: null,
  };
}
