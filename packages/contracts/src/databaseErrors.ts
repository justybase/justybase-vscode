/**
 * Serializable Netezza/PostgreSQL-style backend diagnostics.
 *
 * The DTO is deliberately transport-safe:
 *
 * - it never carries the driver's `raw` payload;
 * - {@link DatabaseErrorDetails.code} is the SQLSTATE reported by the database
 *   (for example `42P01`), never an API error code (`QUERY_FAILED`) or a
 *   transport code (`ECONNRESET`). Consumers must keep the two namespaces
 *   separate;
 * - every field is optional so older producers and consumers stay compatible.
 *
 * Products populate it through the shared extractor in
 * `@justybase/database-runtime` rather than by inspecting driver classes:
 * errors can cross a bundle boundary where `instanceof` is unreliable.
 */
export interface DatabaseErrorDetails {
  /** SQLSTATE / backend error code, e.g. `42P01`. Not an API or transport code. */
  code?: string;
  /** Backend severity: `ERROR`, `FATAL`, `PANIC`, `WARNING`, `NOTICE`, `DEBUG`. */
  severity?: string;
  /** Secondary backend detail message. */
  detail?: string;
  /** Suggested remediation reported by the backend. */
  hint?: string;
  /** Remaining protocol diagnostic fields, keyed by their backend field code. */
  diagnostics?: Record<string, string>;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Structural guard for transport validation. Keeps foreign or malformed
 * diagnostic payloads out of product state without relying on `instanceof`.
 */
export function isDatabaseErrorDetails(value: unknown): value is DatabaseErrorDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isOptionalString(candidate.code)) return false;
  if (!isOptionalString(candidate.severity)) return false;
  if (!isOptionalString(candidate.detail)) return false;
  if (!isOptionalString(candidate.hint)) return false;
  if (candidate.diagnostics === undefined) return true;
  if (typeof candidate.diagnostics !== 'object' || candidate.diagnostics === null || Array.isArray(candidate.diagnostics)) return false;
  return Object.values(candidate.diagnostics as Record<string, unknown>).every(entry => typeof entry === 'string');
}

/** True when at least one diagnostic field carries a value. */
export function hasDatabaseErrorDetails(
  details: DatabaseErrorDetails | undefined,
): details is DatabaseErrorDetails {
  if (!details) return false;
  return details.code !== undefined
    || details.severity !== undefined
    || details.detail !== undefined
    || details.hint !== undefined
    || (details.diagnostics !== undefined && Object.keys(details.diagnostics).length > 0);
}
