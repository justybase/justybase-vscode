import {
  formatNetezzaSql,
  formatSqlWithProfile,
  type NetezzaFormatOptions,
  type SqlKeywordCase,
} from "@justybase/sql-core";
import type { DatabaseKind } from "../contracts/database";
import { getDatabaseSqlAuthoring } from "../core/sqlAuthoringRegistry";

export type { SqlKeywordCase };

export interface SqlFormatterOptions extends NetezzaFormatOptions {
  databaseKind?: DatabaseKind;
}

/**
 * Desktop entry point for SQL formatting.
 *
 * The implementation is owned by `@justybase/sql-core`; this adapter only
 * resolves the dialect formatter profile from the desktop authoring registry
 * and delegates. Netezza uses the shared Netezza profile directly.
 */
export function formatSql(
  sql: string,
  options: SqlFormatterOptions = {},
): string {
  if (!options.databaseKind || options.databaseKind === "netezza") {
    return formatNetezzaSql(sql, options);
  }

  const formatterProfile = getDatabaseSqlAuthoring(
    options.databaseKind,
  ).formatter;
  return formatSqlWithProfile(sql, formatterProfile, options);
}
