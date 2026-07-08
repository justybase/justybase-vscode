import type { ColumnMetadata } from "../../metadata/types";
import type { ConnectionManager } from "../../core/connectionManager";
import type { MetadataCache } from "../../metadataCache";

export interface MockMetadataTableConfig {
  description?: string;
  columns: ColumnMetadata[];
}

export type MockMetadataTables = Record<string, MockMetadataTableConfig>;

export interface MockConnectionManagerOptions {
  connectionName?: string;
  effectiveDatabase?: string;
  databaseKind?: string;
}

export function createMockColumn(
  name: string,
  type: string,
  description?: string,
): ColumnMetadata {
  return {
    ATTNAME: name,
    FORMAT_TYPE: type,
    detail: type,
    label: name,
    documentation: description || "",
  };
}

export function createMockMetadataCache(
  tables: MockMetadataTables,
): Pick<
  MetadataCache,
  | "getObjectsWithSchema"
  | "getColumns"
  | "getColumnsAnySchema"
  | "findObjectWithType"
> {
  const objects: Array<{
    item: { OBJNAME?: string; TABLENAME?: string; label?: string };
    schema: string;
    description?: string;
  }> = [];

  for (const [key, table] of Object.entries(tables)) {
    const parts = key.split(".");
    const tableName = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
    objects.push({
      item: { OBJNAME: tableName, TABLENAME: tableName },
      schema,
      description: table.description,
    });
  }

  return {
    getObjectsWithSchema: jest.fn((_conn: string, _db: string) => objects),
    getColumns: jest.fn((_conn: string, key: string) => {
      const normalizedKey = key.toUpperCase();
      for (const [k, table] of Object.entries(tables)) {
        const parts = k.split(".");
        const tableName = parts[parts.length - 1];
        const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
        const fullKey = `JUST_DATA_2.${schema}.${tableName}`.toUpperCase();
        if (fullKey === normalizedKey) {
          return table.columns;
        }
      }
      return undefined;
    }),
    getColumnsAnySchema: jest.fn(() => undefined),
    findObjectWithType: jest.fn(
      (_conn: string, _db: string, _schema: string, table: string) => {
        const normalizedTable = table.toUpperCase();
        for (const [k] of Object.entries(tables)) {
          const parts = k.split(".");
          const tableName = parts[parts.length - 1];
          if (tableName.toUpperCase() === normalizedTable) {
            const schema = parts.length > 1 ? parts[parts.length - 2] : "ADMIN";
            return { objType: "TABLE", schema, objId: 1, name: tableName };
          }
        }
        return undefined;
      },
    ),
  };
}

export function createMockConnectionManager(
  options: MockConnectionManagerOptions = {},
): Pick<
  ConnectionManager,
  | "getConnectionForExecution"
  | "getActiveConnectionName"
  | "getEffectiveDatabase"
  | "getConnectionDatabaseKind"
> {
  const connectionName = options.connectionName ?? "TEST_CONN";
  return {
    getConnectionForExecution: jest.fn(() => connectionName),
    getActiveConnectionName: jest.fn(() => connectionName),
    getEffectiveDatabase: jest.fn(
      async () => options.effectiveDatabase ?? "JUST_DATA_2",
    ),
    getConnectionDatabaseKind: jest.fn(
      () => options.databaseKind ?? "netezza",
    ),
  };
}

export function asMetadataCache(
  mock: ReturnType<typeof createMockMetadataCache>,
): MetadataCache {
  return mock as unknown as MetadataCache;
}

export function asConnectionManager(
  mock: ReturnType<typeof createMockConnectionManager>,
): ConnectionManager {
  return mock as unknown as ConnectionManager;
}
