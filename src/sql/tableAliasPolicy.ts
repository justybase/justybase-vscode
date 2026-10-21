/**
 * Table alias policy shared by JOIN completion and `SELECT *` expansion, so
 * both generate the same alias for the same table (`DIMDATE` -> `D`,
 * `FACT_SALES` -> `FS`, collisions -> `D2`, `D3`, ...).
 */

/** Initial of a table name, or initials of a multi-part (`snake_case`) name. */
export function getTableAliasBase(tableName: string): string {
  const words = tableName
    .replace(/^"|"$/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return (words.length > 1
    ? words.map((word) => word[0]).join("")
    : words[0]?.[0] ?? "T").toLocaleUpperCase();
}

/** Returns `preferred` (sanitized) or the first numbered variant not in `usedAliases` (upper-case keys). */
export function getUniqueTableAlias(preferred: string, usedAliases: ReadonlySet<string>): string {
  const base = preferred.replace(/[^A-Za-z0-9_$]/g, "").toUpperCase() || "T";
  if (!usedAliases.has(base)) {
    return base;
  }
  let suffix = 2;
  while (usedAliases.has(`${base}${suffix}`)) {
    suffix += 1;
  }
  return `${base}${suffix}`;
}
