/**
 * Canonical JOIN relation and FROM object identity.
 *
 * A relation is identified by the whole unordered table pair plus fully
 * qualified column pairs. Tables and columns are never sorted independently:
 * each column stays bound to its table, and orientation flips the whole pair.
 */

export interface TableRef {
  database?: string;
  schema?: string;
  table: string;
}

export interface ColumnPair {
  leftTable: TableRef;
  leftColumn: string;
  rightTable: TableRef;
  rightColumn: string;
}

export interface RelationColumn {
  left: string;
  right: string;
}

export interface RelationInput {
  left: TableRef;
  right: TableRef;
  columns: ReadonlyArray<RelationColumn>;
}

export interface RelationDisplay {
  left: TableRef;
  right: TableRef;
  columns: RelationColumn[];
}

export interface RelationIdentity {
  /** Canonical unordered relation key. */
  key: string;
  /** Lexicographically sorted table pair. */
  tables: [TableRef, TableRef];
  /** Column pairs after whole-pair orientation. */
  columnPairs: ColumnPair[];
  /** First-observed writing order, kept for SQL generation. */
  display: RelationDisplay;
}

export interface ObjectRef {
  database?: string;
  schema?: string;
  name: string;
}

export interface IdentityDefaults {
  database?: string;
  schema?: string;
}

export type IdentityDatabaseKind = string | undefined;

const POSTGRES_LIKE_KINDS = new Set([
  "postgresql",
  "vertica",
  "duckdb",
  "file",
]);

function stripIdentifierQuotes(value: string): {
  value: string;
  quoted: boolean;
} {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && trimmed.startsWith('"')
    && trimmed.endsWith('"')
  ) {
    return { value: trimmed.slice(1, -1).replace(/""/g, '"'), quoted: true };
  }
  return { value: trimmed, quoted: false };
}

/**
 * Normalize one identifier for identity comparison.
 *
 * Netezza and ANSI dialects fold unquoted names to UPPER; PostgreSQL-like
 * dialects fold to lower. Quoted names keep their exact bytes.
 */
export function normalizeIdentityIdentifier(
  value: string | undefined,
  databaseKind?: IdentityDatabaseKind,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = stripIdentifierQuotes(value);
  if (!parsed.value) {
    return undefined;
  }
  if (parsed.quoted) {
    return parsed.value;
  }
  if (POSTGRES_LIKE_KINDS.has(databaseKind ?? "")) {
    return parsed.value.toLocaleLowerCase();
  }
  return parsed.value.toLocaleUpperCase();
}

function withDefaults(
  ref: TableRef,
  defaults?: IdentityDefaults,
): TableRef {
  const database = ref.database ?? defaults?.database;
  const schema = ref.schema ?? defaults?.schema;
  return {
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    table: ref.table,
  };
}

/**
 * Normalize a table reference, filling database/schema from the active scope
 * when the reference is unqualified.
 */
export function normalizeTableRef(
  ref: TableRef | undefined,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): TableRef | undefined {
  if (!ref) {
    return undefined;
  }
  const table = normalizeIdentityIdentifier(ref.table, databaseKind);
  if (!table) {
    return undefined;
  }
  const database = normalizeIdentityIdentifier(
    ref.database ?? defaults?.database,
    databaseKind,
  );
  const schema = normalizeIdentityIdentifier(
    ref.schema ?? defaults?.schema,
    databaseKind,
  );
  return {
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    table,
  };
}

export function tableRefKey(ref: TableRef): string {
  return `${ref.database ?? ""}\u0000${ref.schema ?? ""}\u0000${ref.table}`;
}

export function tableRefsEqual(
  left: TableRef | undefined,
  right: TableRef | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return tableRefKey(left) === tableRefKey(right);
}

/** Compare two already-normalized table references deterministically. */
export function compareTableRefs(left: TableRef, right: TableRef): number {
  return tableRefKey(left).localeCompare(tableRefKey(right), "en");
}

function normalizeColumnName(
  column: string,
  databaseKind?: IdentityDatabaseKind,
): string | undefined {
  return normalizeIdentityIdentifier(column, databaseKind);
}

function pairKey(pair: ColumnPair): string {
  return `${tableRefKey(pair.leftTable)}.${pair.leftColumn}\u0001${tableRefKey(pair.rightTable)}.${pair.rightColumn}`;
}

function orientColumnPair(
  pair: ColumnPair,
  leftTable: TableRef,
  rightTable: TableRef,
): ColumnPair | undefined {
  const leftIsLeft = tableRefsEqual(pair.leftTable, leftTable);
  const leftIsRight = tableRefsEqual(pair.leftTable, rightTable);
  const rightIsLeft = tableRefsEqual(pair.rightTable, leftTable);
  const rightIsRight = tableRefsEqual(pair.rightTable, rightTable);

  if (leftIsLeft && rightIsRight) {
    return pair;
  }
  if (leftIsRight && rightIsLeft) {
    return {
      leftTable: pair.rightTable,
      leftColumn: pair.rightColumn,
      rightTable: pair.leftTable,
      rightColumn: pair.leftColumn,
    };
  }
  return undefined;
}

/** Canonical key from an already-oriented column-pair list. */
export function relationKeyFromColumnPairs(
  tables: readonly [TableRef, TableRef],
  columnPairs: readonly ColumnPair[],
): string {
  const sortedPairs = [...columnPairs].map(pairKey).sort();
  return [
    tableRefKey(tables[0]),
    tableRefKey(tables[1]),
    sortedPairs.join("&"),
  ].join("|");
}

/**
 * Canonicalize a relation. Returns `undefined` for an unusable identity
 * (missing table/column names, self-relation or a column not bound to one of
 * the two tables). Callers must skip such a clause rather than guess.
 */
export function canonicalizeRelation(
  input: RelationInput,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): RelationIdentity | undefined {
  const left = normalizeTableRef(input.left, databaseKind, defaults);
  const right = normalizeTableRef(input.right, databaseKind, defaults);
  if (!left || !right || tableRefsEqual(left, right) || input.columns.length === 0) {
    return undefined;
  }

  const displayColumns: RelationColumn[] = [];
  const boundPairs: ColumnPair[] = [];
  for (const column of input.columns) {
    const leftColumn = normalizeColumnName(column.left, databaseKind);
    const rightColumn = normalizeColumnName(column.right, databaseKind);
    if (!leftColumn || !rightColumn) {
      return undefined;
    }
    displayColumns.push({
      left: column.left.trim(),
      right: column.right.trim(),
    });
    boundPairs.push({
      leftTable: left,
      leftColumn,
      rightTable: right,
      rightColumn,
    });
  }

  const swap = compareTableRefs(left, right) > 0;
  const tables: [TableRef, TableRef] = swap ? [right, left] : [left, right];
  const columnPairs: ColumnPair[] = [];
  for (const pair of boundPairs) {
    const oriented = orientColumnPair(pair, tables[0], tables[1]);
    if (!oriented) {
      return undefined;
    }
    columnPairs.push(oriented);
  }
  columnPairs.sort((a, b) => pairKey(a).localeCompare(pairKey(b), "en"));

  const displayLeft = withDefaults(input.left, defaults);
  const displayRight = withDefaults(input.right, defaults);
  return {
    key: relationKeyFromColumnPairs(tables, columnPairs),
    tables,
    columnPairs,
    display: {
      left: displayLeft,
      right: displayRight,
      columns: displayColumns,
    },
  };
}

/**
 * Deterministic display derived from the canonical orientation. Aggregated
 * workspace evidence uses this so two files writing the same join in opposite
 * directions produce one byte-identical snapshot entry.
 */
export function canonicalRelationDisplay(
  relation: RelationIdentity,
): RelationDisplay {
  return {
    left: relation.tables[0],
    right: relation.tables[1],
    columns: relation.columnPairs.map((pair) => ({
      left: pair.leftColumn,
      right: pair.rightColumn,
    })),
  };
}

/**
 * Rebuild and verify a relation identity loaded from storage. A stored key
 * that no longer matches the canonicalized relation is rejected.
 */
export function verifyRelationIdentity(
  relation: RelationIdentity,
  databaseKind?: IdentityDatabaseKind,
): RelationIdentity | undefined {
  const canonical = canonicalizeRelation(
    {
      left: relation.display.left,
      right: relation.display.right,
      columns: relation.display.columns,
    },
    databaseKind,
  );
  if (!canonical || canonical.key !== relation.key) {
    return undefined;
  }
  return canonical;
}

/** Normalize a FROM object reference (database + schema + name). */
export function normalizeObjectRef(
  ref: ObjectRef | undefined,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): ObjectRef | undefined {
  if (!ref) {
    return undefined;
  }
  const name = normalizeIdentityIdentifier(ref.name, databaseKind);
  if (!name) {
    return undefined;
  }
  const database = normalizeIdentityIdentifier(
    ref.database ?? defaults?.database,
    databaseKind,
  );
  const schema = normalizeIdentityIdentifier(
    ref.schema ?? defaults?.schema,
    databaseKind,
  );
  return {
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    name,
  };
}

/**
 * Object identity key: database + schema + name. The object type is
 * intentionally excluded, so a rename/type change of the same object keeps
 * its preference; same-named objects in different schemas stay distinct.
 */
export function objectRefKey(ref: ObjectRef): string {
  return `${ref.database ?? ""}\u0000${ref.schema ?? ""}\u0000${ref.name}`;
}

/**
 * Column usage key: object key + NUL + column name without quotes, upper-cased.
 * Case is folded for every dialect because column ranking is a soft ordering
 * signal and catalog spellings differ from the spelling written in SQL.
 */
export function columnUsageKey(objectKey: string, column: string): string | undefined {
  const parsed = stripIdentifierQuotes(column);
  if (!parsed.value || parsed.value === "*") {
    return undefined;
  }
  return `${objectKey}\u0000${parsed.value.toLocaleUpperCase()}`;
}

/** Canonical relation key for an existing relation plus a candidate pair list. */
export function relationKeyForTables(
  left: TableRef,
  right: TableRef,
  columns: ReadonlyArray<RelationColumn>,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): string | undefined {
  return canonicalizeRelation({ left, right, columns }, databaseKind, defaults)?.key;
}
