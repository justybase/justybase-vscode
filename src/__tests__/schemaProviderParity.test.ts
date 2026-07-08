import { MetadataCacheSchemaProvider } from "../sqlParser/metadataCacheAdapter";
import {
  LspSchemaProvider,
  type LspSchemaProviderBridge,
} from "../server/lspSchemaProvider";
import type { MetadataTableInfoResponse } from "../lsp/protocol";
import type { MetadataCache } from "../metadataCache";
import type { ColumnMetadata } from "../metadata/types";
import type { ConnectionManager } from "../core/connectionManager";

interface SharedTableFixture {
  database: string;
  schema: string;
  table: string;
  exists: boolean;
  columns: Array<{ name: string; dataType: string }>;
}

const DOC_URI = "file:///parity.sql";
const CONNECTION = "CONN_1";
const EFFECTIVE_DB = "MYDB";

const SHARED_TABLES: SharedTableFixture[] = [
  {
    database: "MYDB",
    schema: "ADMIN",
    table: "USERS",
    exists: true,
    columns: [
      { name: "ID", dataType: "INTEGER" },
      { name: "NAME", dataType: "VARCHAR(100)" },
    ],
  },
  {
    database: "MYDB",
    schema: "ADMIN",
    table: "DELETED",
    exists: false,
    columns: [],
  },
];

function createLspProvider(
  tables: SharedTableFixture[],
  options: {
    effectiveDatabase?: string;
    hasTableListForDatabase?: boolean;
  } = {},
): LspSchemaProvider {
  const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
  for (const table of tables) {
    const key = `${DOC_URI}|${table.database}|${table.schema}|${table.table.toUpperCase()}`;
    tableInfoMap.set(key, {
      exists: table.exists,
      table: table.table,
      database: table.database,
      schema: table.schema,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.dataType,
      })),
    });
  }

  const bridge: LspSchemaProviderBridge = {
    findCachedTableInfo: (
      documentUri: string,
      table: string,
      database?: string,
      schema?: string,
    ) => {
      const key = `${documentUri}|${database || ""}|${schema || ""}|${table.toUpperCase()}`;
      return tableInfoMap.get(key);
    },
    hasAnyTableInfo: (documentUri: string) =>
      documentUri === DOC_URI && tables.some((table) => table.exists),
    hasCachedTableListForDatabase: (_documentUri, database) =>
      options.hasTableListForDatabase === true &&
      database.toUpperCase() === EFFECTIVE_DB,
    getCachedQualificationProposals: () => [],
  };

  return new LspSchemaProvider(
    bridge,
    DOC_URI,
    options.effectiveDatabase,
  );
}

function createMetadataProvider(
  tables: SharedTableFixture[],
  options: {
    preferredDatabase?: string;
    hasTableListForDatabase?: boolean;
  } = {},
): MetadataCacheSchemaProvider {
  const columnStore = new Map<string, ColumnMetadata[]>();
  for (const table of tables) {
    columnStore.set(
      `${CONNECTION}|${table.database}.${table.schema}.${table.table}`,
      table.columns.map(
        (column) =>
          ({
            ATTNAME: column.name,
            FORMAT_TYPE: column.dataType,
          }) as ColumnMetadata,
      ),
    );
  }

  const tableList = tables
    .filter((table) => table.exists)
    .map((table) => ({ OBJNAME: table.table }));

  const mockCache = {
    getDatabases: jest.fn(() => [{ DATABASE: EFFECTIVE_DB }]),
    getTables: jest.fn((connectionName: string, key: string) => {
      if (!options.hasTableListForDatabase || connectionName !== CONNECTION) {
        return undefined;
      }
      if (key === `${EFFECTIVE_DB}.ADMIN`) {
        return tableList;
      }
      return undefined;
    }),
    getTablesAllSchemas: jest.fn((connectionName: string, database: string) => {
      if (
        connectionName === CONNECTION &&
        database === EFFECTIVE_DB &&
        options.hasTableListForDatabase
      ) {
        return tableList;
      }
      return undefined;
    }),
    getColumns: jest.fn((connectionName: string, key: string) =>
      columnStore.get(`${connectionName}|${key}`),
    ),
    getColumnsAnySchema: jest.fn(),
  } as unknown as MetadataCache;

  const mockConnectionManager = {
    getActiveConnectionName: jest.fn(() => CONNECTION),
    getConnectionForExecution: jest.fn(() => CONNECTION),
    getDocumentDatabase: jest.fn(() => options.preferredDatabase ?? EFFECTIVE_DB),
    getConnectionMetadata: jest.fn(() => ({
      name: CONNECTION,
      host: "host",
      database: options.preferredDatabase ?? EFFECTIVE_DB,
      user: "user",
    })),
  } as unknown as ConnectionManager;

  return new MetadataCacheSchemaProvider(
    mockCache,
    mockConnectionManager,
  );
}

describe("schema provider parity", () => {
  it("maps cached columns and dataType consistently", () => {
    const lsp = createLspProvider(SHARED_TABLES);
    const metadata = createMetadataProvider(SHARED_TABLES);

    const lspTable = lsp.getTable("MYDB", "ADMIN", "USERS");
    const metadataTable = metadata.getTable("MYDB", "ADMIN", "USERS");

    expect(lspTable).toEqual(metadataTable);
    expect(lspTable?.columns).toEqual([
      { name: "ID", dataType: "INTEGER" },
      { name: "NAME", dataType: "VARCHAR(100)" },
    ]);
  });

  it("agrees on explicit missing tables in cache", () => {
    const lsp = createLspProvider(SHARED_TABLES);
    const metadata = createMetadataProvider(SHARED_TABLES, {
      hasTableListForDatabase: true,
      preferredDatabase: EFFECTIVE_DB,
    });

    expect(lsp.tableExists("MYDB", "ADMIN", "DELETED")).toBe(false);
    expect(metadata.tableExists("MYDB", "ADMIN", "DELETED")).toBe(false);
  });

  it("stays permissive when table metadata is absent from cache", () => {
    const lsp = createLspProvider(SHARED_TABLES);
    const metadata = createMetadataProvider(SHARED_TABLES);

    expect(lsp.tableExists("MYDB", "ADMIN", "UNKNOWN")).toBe(true);
    expect(metadata.tableExists("MYDB", "ADMIN", "UNKNOWN")).toBe(true);
  });

  it("enables unqualified validation when effective database table list is cached", () => {
    const lsp = createLspProvider(SHARED_TABLES, {
      effectiveDatabase: EFFECTIVE_DB,
      hasTableListForDatabase: true,
    });
    const metadata = createMetadataProvider(SHARED_TABLES, {
      preferredDatabase: EFFECTIVE_DB,
      hasTableListForDatabase: true,
    });

    expect(lsp.canValidateUnqualifiedTableReferences()).toBe(true);
    expect(metadata.canValidateUnqualifiedTableReferences()).toBe(true);
  });

  /**
   * Mirrored system catalog resolution stays extension-host only.
   * LSP defers to permissive tableExists when cache is incomplete.
   */
  it("documents known parity limit for mirrored catalog lookups", () => {
    const lsp = createLspProvider([], {
      effectiveDatabase: EFFECTIVE_DB,
      hasTableListForDatabase: false,
    });
    const metadata = createMetadataProvider([], {
      preferredDatabase: EFFECTIVE_DB,
      hasTableListForDatabase: false,
    });

    expect(lsp.canValidateUnqualifiedTableReferences()).toBe(false);
    expect(metadata.canValidateUnqualifiedTableReferences()).toBe(false);
  });
});
