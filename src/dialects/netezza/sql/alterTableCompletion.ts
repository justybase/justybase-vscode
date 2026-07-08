/**
 * Netezza ALTER TABLE completion keyword and type suggestions by phase.
 */

export type AlterTablePhase =
  | "top_level"
  | "add"
  | "add_column"
  | "add_column_type"
  | "add_constraint"
  | "drop"
  | "drop_column"
  | "drop_constraint"
  | "alter_column"
  | "alter_column_default"
  | "rename"
  | "rename_column"
  | "rename_column_target"
  | "rename_table"
  | "modify_column"
  | "owner_to"
  | "set_privileges"
  | "organize_on"
  | "column_constraint";

export const ALTER_TABLE_TOP_LEVEL_ACTIONS = [
  "ADD COLUMN",
  "ADD",
  "ALTER COLUMN",
  "DROP COLUMN",
  "DROP CONSTRAINT",
  "MODIFY COLUMN",
  "OWNER TO",
  "RENAME COLUMN",
  "RENAME TO",
  "SET PRIVILEGES TO",
  "ORGANIZE ON",
] as const;

export const ALTER_TABLE_ADD_KEYWORDS = ["COLUMN", "CONSTRAINT"] as const;

export const ALTER_TABLE_DROP_KEYWORDS = ["COLUMN", "CONSTRAINT"] as const;

export const ALTER_TABLE_RENAME_KEYWORDS = ["COLUMN", "TO"] as const;

export const ALTER_TABLE_ALTER_COLUMN_KEYWORDS = [
  "SET DEFAULT",
  "DROP DEFAULT",
] as const;

export const ALTER_TABLE_CONSTRAINT_KEYWORDS = [
  "NOT NULL",
  "NULL",
  "UNIQUE",
  "PRIMARY KEY",
  "FOREIGN KEY",
  "REFERENCES",
  "DEFAULT",
  "CONSTRAINT",
  "CHECK",
] as const;

export const ALTER_TABLE_CASCADE_KEYWORDS = ["CASCADE", "RESTRICT"] as const;

export const NETEZZA_ALTER_TABLE_DATA_TYPES = [
  "BOOLEAN",
  "BYTEINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "REAL",
  "DOUBLE",
  "NUMERIC",
  "DECIMAL",
  "CHAR",
  "VARCHAR",
  "NCHAR",
  "NVARCHAR",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "INTERVAL",
  "BYTEA",
  "VARBYTE",
] as const;

const ALTER_TABLE_KEYWORD_PREFIXES = new Set([
  "ADD",
  "DROP",
  "ALTER",
  "COLUMN",
  "MODIFY",
  "RENAME",
  "TO",
  "OWNER",
  "SET",
  "PRIVILEGES",
  "ON",
  "CONSTRAINT",
  "ORGANIZE",
  "DEFAULT",
  "CASCADE",
  "RESTRICT",
  "NONE",
]);

export function normalizeAlterTableTypedPrefix(
  phase: AlterTablePhase,
  typedPrefix: string,
  tableName: string,
): string {
  const normalizedPrefix = typedPrefix.toUpperCase();
  const normalizedTable = tableName.toUpperCase();

  if (
    phase === "top_level" &&
    (normalizedPrefix === normalizedTable ||
      normalizedTable.startsWith(normalizedPrefix))
  ) {
    return "";
  }

  if (ALTER_TABLE_KEYWORD_PREFIXES.has(normalizedPrefix)) {
    return "";
  }

  if (phase === "add_column_type" || phase === "column_constraint") {
    const matchesKnownType = NETEZZA_ALTER_TABLE_DATA_TYPES.some((typeName) =>
      typeName.startsWith(normalizedPrefix),
    );
    if (!matchesKnownType && normalizedPrefix.length > 0) {
      return "";
    }
  }

  return typedPrefix;
}

export function getAlterTableKeywordsForPhase(
  phase: AlterTablePhase,
): readonly string[] {
  switch (phase) {
    case "top_level":
      return ALTER_TABLE_TOP_LEVEL_ACTIONS;
    case "add":
      return ALTER_TABLE_ADD_KEYWORDS;
    case "drop":
      return ALTER_TABLE_DROP_KEYWORDS;
    case "rename":
      return ALTER_TABLE_RENAME_KEYWORDS;
    case "alter_column_default":
      return ALTER_TABLE_ALTER_COLUMN_KEYWORDS;
    case "add_constraint":
    case "column_constraint":
      return ALTER_TABLE_CONSTRAINT_KEYWORDS;
    case "drop_column":
    case "drop_constraint":
      return ALTER_TABLE_CASCADE_KEYWORDS;
    case "add_column_type":
      return NETEZZA_ALTER_TABLE_DATA_TYPES;
    case "organize_on":
      return ["NONE"];
    default:
      return [];
  }
}
