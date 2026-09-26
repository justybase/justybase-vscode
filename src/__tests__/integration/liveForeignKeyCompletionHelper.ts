import {
  CompletionTriggerKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { LspCompletionEngine } from "../../server/completionEngine";
import type { CompletionMetadataProvider } from "../../server/completionTypes";
import type { DatabaseKind } from "../../contracts/database";
import type { MetadataColumnItem, MetadataObjectItem } from "../../lsp/protocol";
import { DEFAULT_JOIN_COMPLETION_SETTINGS } from "../../lsp/joinCompletionSettings";

interface ForeignKeyRow {
  FROM_DATABASE?: unknown;
  FROM_SCHEMA?: unknown;
  FROM_TABLE?: unknown;
  FROM_COLUMN?: unknown;
  TO_DATABASE?: unknown;
  TO_SCHEMA?: unknown;
  TO_TABLE?: unknown;
  TO_COLUMN?: unknown;
  CONSTRAINT_NAME?: unknown;
  ORDINAL_POSITION?: unknown;
  [key: string]: unknown;
}

export interface LiveForeignKeyCompletionInput {
  databaseKind: DatabaseKind;
  database: string;
  schema: string;
  parentTable: string;
  childTable: string;
  rows: readonly ForeignKeyRow[];
}

export interface LiveVirtualJoinCompletionInput {
  databaseKind: DatabaseKind;
  database: string;
  schema: string;
  leftTable: string;
  rightTable: string;
  columns: ReadonlyArray<{ left: string; right: string }>;
}

export function requireForeignKeyRelationshipQuery(
  query: string | undefined,
  databaseKind: DatabaseKind,
): string {
  if (!query) {
    throw new Error(`${databaseKind} metadata provider does not expose an FK relationship query.`);
  }
  return query;
}

function field(row: ForeignKeyRow, name: string): string {
  const match = Object.keys(row).find((key) => key.toUpperCase() === name);
  const value = match ? row[match] : undefined;
  return String(value ?? "").trim();
}

function normalize(value: string): string {
  return value.replace(/^['"`\u005B]|['"`\u005D]$/g, "").trim().toUpperCase();
}

function normalizeSql(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u005B\u005D"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function createDocument(sqlWithCursor: string): { document: TextDocument; cursorOffset: number } {
  const cursorOffset = sqlWithCursor.indexOf("|");
  if (cursorOffset < 0) throw new Error("Missing SQL completion cursor marker");
  const sql = `${sqlWithCursor.slice(0, cursorOffset)}${sqlWithCursor.slice(cursorOffset + 1)}`;
  return {
    document: TextDocument.create(
      `file:///live-fk-completion-${Math.random().toString(36).slice(2)}.sql`,
      "sql",
      1,
      sql,
    ),
    cursorOffset,
  };
}

export async function expectLiveForeignKeyCompletion(
  input: LiveForeignKeyCompletionInput,
): Promise<void> {
  const references = input.rows.flatMap((row) => {
    const fromTable = field(row, "FROM_TABLE");
    const toTable = field(row, "TO_TABLE");
    const fromColumn = field(row, "FROM_COLUMN");
    const toColumn = field(row, "TO_COLUMN");
    if (
      normalize(fromTable) !== normalize(input.childTable)
      || normalize(toTable) !== normalize(input.parentTable)
      || !fromColumn
      || !toColumn
    ) return [];
    const ordinal = Number(field(row, "ORDINAL_POSITION"));
    return [{
      fromDatabase: field(row, "FROM_DATABASE") || input.database,
      fromSchema: field(row, "FROM_SCHEMA") || input.schema,
      fromTable,
      fromColumn,
      toDatabase: field(row, "TO_DATABASE") || input.database,
      toSchema: field(row, "TO_SCHEMA") || input.schema,
      toTable,
      toColumn,
      constraintName: field(row, "CONSTRAINT_NAME") || undefined,
      ordinalPosition: Number.isFinite(ordinal) ? ordinal : undefined,
    }];
  });
  if (references.length === 0) {
    throw new Error(`The live FK query returned no relationship from ${input.childTable} to ${input.parentTable}.`);
  }
  references.sort((left, right) => (left.ordinalPosition ?? 0) - (right.ordinalPosition ?? 0));

  const columnsByTable = new Map<string, Map<string, MetadataColumnItem>>();
  const getColumn = (table: string, column: string): MetadataColumnItem => {
    const key = normalize(table);
    let tableColumns = columnsByTable.get(key);
    if (!tableColumns) {
      tableColumns = new Map();
      columnsByTable.set(key, tableColumns);
    }
    const columnKey = normalize(column);
    let item = tableColumns.get(columnKey);
    if (!item) {
      item = { name: column };
      tableColumns.set(columnKey, item);
    }
    return item;
  };
  for (const reference of references) {
    const childColumn = getColumn(input.childTable, reference.fromColumn);
    childColumn.isFk = true;
    childColumn.joinReferences = [...(childColumn.joinReferences ?? []), reference];
    getColumn(input.parentTable, reference.toColumn).isPk = true;
  }

  const exactJoinMatches = references.map((reference) => ({
    sourceTable: input.parentTable,
    sourceSchema: input.schema,
    sourceColumn: reference.toColumn,
    targetColumn: reference.fromColumn,
    relationType: "foreignKey" as const,
    constraintName: reference.constraintName,
    ordinalPosition: reference.ordinalPosition,
  }));
  const provider: CompletionMetadataProvider = {
    getContext: async () => ({
      effectiveDatabase: input.database,
      effectiveSchema: input.schema,
      databaseKind: input.databaseKind,
      joinCompletionSettings: {
        ...DEFAULT_JOIN_COMPLETION_SETTINGS,
        nameHeuristicsEnabled: false,
        aliases: [{
          table: { database: input.database, schema: input.schema, table: input.childTable },
          alias: "C",
        }],
      },
    }),
    getDatabases: async () => [],
    getSchemas: async () => [],
    getTables: async () => [],
    getViews: async () => [],
    getProcedures: async () => [],
    getColumns: async (_uri, _database, table) => [
      ...(columnsByTable.get(normalize(table))?.values() ?? []),
    ],
    getCachedJoinTargets: async (_uri, _database, sources): Promise<MetadataObjectItem[]> => {
      if (!sources.some((source) => normalize(source.table) === normalize(input.parentTable))) return [];
      return [{
        name: input.childTable,
        database: input.database,
        schema: input.schema,
        objectType: "table",
        joinMatches: exactJoinMatches,
      }];
    },
  };
  const engine = new LspCompletionEngine(provider);

  const onDocument = createDocument(`SELECT * FROM ${input.parentTable} P JOIN ${input.childTable} C ON |`);
  const onItems = await engine.provideCompletionItems(
    onDocument.document,
    onDocument.document.positionAt(onDocument.cursorOffset),
    CompletionTriggerKind.TriggerCharacter,
  );
  const expectedPredicate = references.map((reference) =>
    `P.${reference.toColumn} = C.${reference.fromColumn}`,
  ).join(" AND ");
  expect(onItems.some((item) =>
    item.detail === "Join condition (declared foreign key)"
    && normalizeSql(item.insertText) === normalizeSql(expectedPredicate),
  )).toBe(true);

  const targetDocument = createDocument(`SELECT * FROM ${input.parentTable} P JOIN |`);
  const targetItems = await engine.provideCompletionItems(
    targetDocument.document,
    targetDocument.document.positionAt(targetDocument.cursorOffset),
    CompletionTriggerKind.TriggerCharacter,
  );
  const target = targetItems.find((item) => item.detail === "JOIN with declared foreign key");
  expect(target).toBeDefined();
  expect(normalizeSql(target?.insertText)).toContain(normalizeSql(expectedPredicate));
}

export async function expectLiveVirtualJoinCompletion(
  input: LiveVirtualJoinCompletionInput,
): Promise<void> {
  const leftIdentity = { database: input.database, schema: input.schema, table: input.leftTable };
  const rightIdentity = { database: input.database, schema: input.schema, table: input.rightTable };
  const relation = {
    left: leftIdentity,
    right: rightIdentity,
    columns: input.columns.map((pair) => ({ ...pair })),
  };
  const provider: CompletionMetadataProvider = {
    getContext: async () => ({
      effectiveDatabase: input.database,
      effectiveSchema: input.schema,
      databaseKind: input.databaseKind,
      joinCompletionSettings: {
        ...DEFAULT_JOIN_COMPLETION_SETTINGS,
        nameHeuristicsEnabled: false,
        aliases: [{ table: rightIdentity, alias: "C" }],
        relations: [relation],
      },
    }),
    getDatabases: async () => [],
    getSchemas: async () => [],
    getTables: async () => [],
    getViews: async () => [],
    getProcedures: async () => [],
    getColumns: async () => [],
    getCachedJoinTargets: async () => [],
  };
  const engine = new LspCompletionEngine(provider);

  const joinDocument = createDocument(`SELECT * FROM ${input.leftTable} L JOIN |`);
  const joinItems = await engine.provideCompletionItems(
    joinDocument.document,
    joinDocument.document.positionAt(joinDocument.cursorOffset),
    CompletionTriggerKind.TriggerCharacter,
  );
  const expectedJoinPredicates = input.columns.map((pair) =>
    `L.${pair.left} = C.${pair.right}`,
  ).join(" AND ");
  const joinItem = joinItems.find((item) => item.detail === "JOIN with configured relationship");
  expect(joinItem).toBeDefined();
  expect(normalizeSql(joinItem?.insertText)).toContain(normalizeSql(expectedJoinPredicates));

  const onDocument = createDocument(
    `SELECT * FROM ${input.leftTable} L JOIN ${input.rightTable} C ON |`,
  );
  const onItems = await engine.provideCompletionItems(
    onDocument.document,
    onDocument.document.positionAt(onDocument.cursorOffset),
    CompletionTriggerKind.TriggerCharacter,
  );
  expect(onItems.some((item) =>
    item.detail === "Join condition (configured relationship)"
    && normalizeSql(item.insertText) === normalizeSql(expectedJoinPredicates),
  )).toBe(true);
}
