import type { DatabaseErrorDetails } from '@justybase/contracts';

/**
 * Shared, structural extraction of Netezza/PostgreSQL backend diagnostics.
 *
 * The extractor intentionally avoids `instanceof` checks against driver
 * classes: a driver error can be produced by a separately bundled copy of the
 * module (desktop extension host, API worker, LSP server), so structural
 * inspection of the error chain is the only reliable test.
 *
 * It walks `cause` links so diagnostics survive wrapping by product errors
 * such as `ExecutedSqlError`, `ExecutionBackendError`, or a batch failure.
 */

/** Upper bound for one extracted message field, in characters. */
export const MAX_ERROR_DETAIL_LENGTH = 4000;

const MAX_DIAGNOSTIC_FIELDS = 32;
const MAX_DIAGNOSTIC_KEY_LENGTH = 64;
const MAX_CAUSE_DEPTH = 8;

/** SQLSTATE is exactly five upper-case alphanumerics (e.g. `42P01`, `08S01`). */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Protocol diagnostic keys that must never leave the process boundary.
 * Values are dropped rather than redacted so the DTO stays a safe allow-list.
 */
const SENSITIVE_DIAGNOSTIC_KEY_PATTERN = /pass|secret|token|credential|private|api[-_]?key|auth/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_ERROR_DETAIL_LENGTH
    ? trimmed.slice(0, MAX_ERROR_DETAIL_LENGTH)
    : trimmed;
}

function readDiagnostics(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const diagnostics: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= MAX_DIAGNOSTIC_FIELDS) break;
    const key = rawKey.trim().slice(0, MAX_DIAGNOSTIC_KEY_LENGTH);
    if (key.length === 0) continue;
    if (SENSITIVE_DIAGNOSTIC_KEY_PATTERN.test(key)) continue;
    const text = readText(rawValue);
    if (text === undefined) continue;
    diagnostics[key] = text;
    count += 1;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function isSqlStateCode(value: unknown): value is string {
  return typeof value === 'string' && SQLSTATE_PATTERN.test(value.trim());
}

const DATABASE_ERROR_NAME_PATTERN = /(?:databaseerror|sqlerror|sqlstate)/iu;

/**
 * Structural markers identifying a *database-reported* error.
 *
 * This is intentionally separate from "has diagnostic fields". A live Netezza
 * instance answers errors with legacy text: the driver builds
 * `NzDatabaseError` with a populated `dbMessage`, an empty `diagnostics` map,
 * and no `code`/`severity`/`detail`/`hint` at all. That is still a database
 * error, so classification must not depend on the diagnostics being populated
 * or a genuine SQL failure would be treated as a transport failure.
 *
 * `detail` and `hint` are deliberately not markers on their own: unrelated
 * errors can expose them, and treating such an error as a SQL failure would
 * suppress reconnect/replay for a real transport failure.
 */
function looksLikeDatabaseError(record: Record<string, unknown>): boolean {
  if (typeof record.dbMessage === 'string') return true;
  if (isSqlStateCode(record.code)) return true;
  if (readText(record.severity) !== undefined) return true;
  if (isRecord(record.diagnostics)) return true;
  return typeof record.name === 'string' && DATABASE_ERROR_NAME_PATTERN.test(record.name);
}

/**
 * A record worth reading diagnostics from. Requiring a strong marker also lets
 * a non-SQLSTATE backend code through without ever mistaking a transport code
 * (`ECONNRESET`) or a product code (`EXECUTION_CANCELLED`) for a database code.
 */
function hasStructuredDiagnostics(record: Record<string, unknown>): boolean {
  if (typeof record.dbMessage === 'string') return true;
  if (isSqlStateCode(record.code)) return true;
  if (readText(record.severity) !== undefined) return true;
  return isRecord(record.diagnostics);
}

function candidateDetails(value: unknown): DatabaseErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasStructuredDiagnostics(value)) return undefined;
  const code = readText(value.code);
  const severity = readText(value.severity);
  const detail = readText(value.detail);
  const hint = readText(value.hint);
  const diagnostics = readDiagnostics(value.diagnostics);
  if (
    code === undefined
    && severity === undefined
    && detail === undefined
    && hint === undefined
    && diagnostics === undefined
  ) {
    return undefined;
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(severity === undefined ? {} : { severity }),
    ...(detail === undefined ? {} : { detail }),
    ...(hint === undefined ? {} : { hint }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

/**
 * Walks an error and its `cause` links, returning the first defined selection.
 * The walk is depth-bounded and cycle-safe because wrapped driver errors can
 * nest arbitrarily deep and a malformed chain could reference itself.
 */
function selectFromErrorChain<T>(
  error: unknown,
  select: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current) || !isRecord(current)) return undefined;
    seen.add(current);

    const selected = select(current);
    if (selected !== undefined) return selected;

    const next = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null || next === current) return undefined;
    current = next;
  }

  return undefined;
}

/**
 * Collect serialisable backend diagnostics from an error or any of its
 * `cause` links. Returns `undefined` when the backend supplied no diagnostic
 * fields, which keeps legacy text-only errors unchanged instead of fabricating
 * fields the server never sent.
 */
export function extractDatabaseErrorDetails(error: unknown): DatabaseErrorDetails | undefined {
  return selectFromErrorChain(error, candidateDetails);
}

/**
 * True when the error chain was reported by a database rather than by the
 * transport or the product. Independent of whether diagnostic fields exist.
 */
export function isDatabaseSqlError(error: unknown): boolean {
  return selectFromErrorChain(error, record => (looksLikeDatabaseError(record) ? true : undefined)) === true;
}

/**
 * True when the error chain carries an explicit SQLSTATE code. A backend code
 * that is not SQLSTATE-shaped (for example a vendor code) returns `false`.
 */
export function hasSqlStateCode(error: unknown): boolean {
  return isSqlStateCode(extractDatabaseErrorDetails(error)?.code);
}

/** SQLSTATE class `08` is "connection exception" (e.g. `08001`, `08S01`). */
const CONNECTION_EXCEPTION_CLASS = '08';

/**
 * True when the backend reported a connection-exception SQLSTATE. Such an
 * error is database-reported but still means the link is unusable, so it must
 * keep the transport reconnect/replay behaviour.
 */
export function isConnectionExceptionSqlState(error: unknown): boolean {
  const code = extractDatabaseErrorDetails(error)?.code;
  return isSqlStateCode(code) && code.startsWith(CONNECTION_EXCEPTION_CLASS);
}
