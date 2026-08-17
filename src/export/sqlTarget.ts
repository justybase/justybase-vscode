const ANSI_IDENTIFIER = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$#]*)';
const MSSQL_IDENTIFIER = `(?:\\[(?:[^\\]]|\\]\\])*\\]|${ANSI_IDENTIFIER})`;

/** Validate a possibly-qualified SQL export target without accepting SQL fragments. */
export function isValidSqlExportTarget(
	tableName: string,
	sqlDialect: string | undefined,
): boolean {
	const identifier = sqlDialect?.toLowerCase() === 'mssql'
		? MSSQL_IDENTIFIER
		: ANSI_IDENTIFIER;
	return new RegExp(`^${identifier}(?:\\.${identifier})*$`).test(tableName);
}
