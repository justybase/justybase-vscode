import type { DatabaseSessionMonitorServices } from '@justybase/contracts';

export interface SessionMonitorResources {
  gra: unknown[];
  systemUtil: unknown[];
  sysUtilSummary: unknown;
}

export function normalizeDatabaseFilter(
  database: string | undefined,
): string | undefined {
  const normalized = database?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function validatePositiveIntegerSessionId(
  sessionId: number,
  dialectLabel = 'database',
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
  _context: unknown,
  services: DatabaseSessionMonitorServices,
  sql: string,
  rowLimit = 1000,
  connectionName?: string,
): Promise<T[]> {
  return services.query<T>(sql, rowLimit, connectionName);
}

export async function executeSessionMonitorStatement(
  _context: unknown,
  services: DatabaseSessionMonitorServices,
  sql: string,
  connectionName?: string,
): Promise<void> {
  await services.execute(sql, connectionName);
}

/** Escape the contents of a SQL string without adding quote characters. */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Compatibility name retained for session-monitor providers that build the
 * surrounding SQL quotes themselves.
 */
export const escapeSqlLiteral = escapeSqlString;

export function emptySessionMonitorResources(): SessionMonitorResources {
  return {
    gra: [],
    systemUtil: [],
    sysUtilSummary: null,
  };
}
