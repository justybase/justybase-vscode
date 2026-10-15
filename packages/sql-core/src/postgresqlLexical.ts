/** PostgreSQL quoting shared by the lexer, source scanner and script splitter. */
export interface PostgresqlQuotedRegion {
  end: number;
  closed: boolean;
}

/** Resolve SQL spelling to PostgreSQL catalog identity. Never fold catalog names. */
export function normalizePostgresqlIdentifier(text: string): string {
  return text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1).replace(/""/g, '"') : text.toLowerCase();
}
export function findPostgresqlQuotedRegion(sql: string, offset: number): PostgresqlQuotedRegion | undefined {
  if (offset > 0 && /[\p{L}\p{N}_$]/u.test(sql[offset - 1])) return undefined;
  if (sql[offset] === '$') {
    const opening = /^(?:\$\$|\$[\p{L}_][\p{L}\p{N}_]*\$)/u.exec(sql.slice(offset));
    if (!opening) return undefined;
    const closing = sql.indexOf(opening[0], offset + opening[0].length);
    return { end: closing < 0 ? sql.length : closing + opening[0].length, closed: closing >= 0 };
  }
  if ((sql[offset] === 'E' || sql[offset] === 'e') && sql[offset + 1] === "'") {
    let i = offset + 2;
    while (i < sql.length) {
      if (sql[i] === '\\') { i += 2; continue; }
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; }
        return { end: i + 1, closed: true };
      }
      i++;
    }
    return { end: sql.length, closed: false };
  }
  return undefined;
}
