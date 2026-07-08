jest.unmock("chevrotain");

import {
  LspSchemaProvider,
  type LspSchemaProviderBridge,
} from "../../server/lspSchemaProvider";
import type { MetadataTableInfoResponse } from "../../lsp/protocol";
import type { QualificationProposal } from "../../core/tableQualificationResolver";
import { SqlValidator } from "../../sqlParser/validator";

function createMockBridge(
  tableInfoMap: Map<string, MetadataTableInfoResponse>,
  hasAnyTableInfoMap: Map<string, boolean> = new Map(),
  hasTableListForDatabase: boolean = false,
  qualificationMap: Map<string, QualificationProposal[]> = new Map(),
): LspSchemaProviderBridge {
  return {
    findCachedTableInfo: jest.fn(
      (
        documentUri: string,
        table: string,
        database?: string,
        schema?: string,
      ) => {
        const key = `${documentUri}|${database || ""}|${schema || ""}|${table.toUpperCase()}`;
        const direct = tableInfoMap.get(key);
        if (direct) {
          return direct;
        }
        for (const [candidateKey, tableInfo] of tableInfoMap.entries()) {
          const [
            candidateUri,
            candidateDatabase,
            candidateSchema,
            candidateTable,
          ] = candidateKey.split("|");
          if (candidateUri !== documentUri) continue;
          if (database && candidateDatabase !== database) continue;
          if (schema && candidateSchema !== schema) continue;
          if (candidateTable === table.toUpperCase()) {
            return tableInfo;
          }
        }
        return undefined;
      },
    ),
    hasAnyTableInfo: jest.fn((documentUri: string) => {
      return hasAnyTableInfoMap.get(documentUri) ?? false;
    }),
    hasCachedTableListForDatabase: jest.fn(
      (_documentUri: string, database: string) =>
        hasTableListForDatabase && database === "MYDB",
    ),
    getCachedQualificationProposals: jest.fn((documentUri, request) => {
      const key = `${documentUri}|${(request.database ?? "").toUpperCase()}|${(request.schema ?? "").toUpperCase()}|${request.name.toUpperCase()}`;
      return qualificationMap.get(key) ?? [];
    }),
  };
}

describe("LspSchemaProvider", () => {
  describe("getTable", () => {
    it("returns TableInfo when table is found in cache", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|USERS", {
        exists: true,
        table: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        columns: [
          { name: "ID", type: "INTEGER" },
          { name: "NAME", type: "VARCHAR(100)" },
        ],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      const result = provider.getTable("MYDB", "ADMIN", "USERS");

      expect(result).toEqual({
        name: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        isCte: false,
        isTempTable: false,
        columns: [
          { name: "ID", dataType: "INTEGER" },
          { name: "NAME", dataType: "VARCHAR(100)" },
        ],
      });
      expect(bridge.findCachedTableInfo).toHaveBeenCalledWith(
        "file://doc1",
        "USERS",
        "MYDB",
        "ADMIN",
      );
    });

    it("returns undefined when table is not found", () => {
      const bridge = createMockBridge(new Map());
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      const result = provider.getTable("MYDB", "ADMIN", "UNKNOWN");

      expect(result).toBeUndefined();
    });

    it("returns undefined when table has no columns", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|EMPTY_TABLE", {
        exists: true,
        table: "EMPTY_TABLE",
        database: "MYDB",
        schema: "ADMIN",
        columns: [],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      const result = provider.getTable("MYDB", "ADMIN", "EMPTY_TABLE");

      expect(result).toBeUndefined();
    });
  });

  describe("tableExists", () => {
    it("returns true when table exists in cache", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|USERS", {
        exists: true,
        table: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        columns: [{ name: "ID" }],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      expect(provider.tableExists("MYDB", "ADMIN", "USERS")).toBe(true);
    });

    it("returns false when table exists=false in cache", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|DELETED", {
        exists: false,
        table: "DELETED",
        database: "MYDB",
        schema: "ADMIN",
        columns: [],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      expect(provider.tableExists("MYDB", "ADMIN", "DELETED")).toBe(false);
    });

    it("returns true (permissive) when table is not in cache", () => {
      const bridge = createMockBridge(new Map());
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      expect(provider.tableExists("MYDB", "ADMIN", "UNKNOWN")).toBe(true);
    });
  });

  describe("canValidateUnqualifiedTableReferences", () => {
    it("returns true when cache has table info for document", () => {
      const hasAnyTableInfoMap = new Map<string, boolean>();
      hasAnyTableInfoMap.set("file://doc1", true);

      const bridge = createMockBridge(new Map(), hasAnyTableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(true);
    });

    it("returns false when cache is empty for document", () => {
      const hasAnyTableInfoMap = new Map<string, boolean>();
      hasAnyTableInfoMap.set("file://doc1", false);

      const bridge = createMockBridge(new Map(), hasAnyTableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(false);
    });

    it("prefers effective-database table list over generic table info", () => {
      const hasAnyTableInfoMap = new Map<string, boolean>();
      hasAnyTableInfoMap.set("file://doc1", false);

      const bridge = createMockBridge(new Map(), hasAnyTableInfoMap, true);
      const provider = new LspSchemaProvider(bridge, "file://doc1", "MYDB");

      expect(provider.canValidateUnqualifiedTableReferences()).toBe(true);
      expect(bridge.hasCachedTableListForDatabase).toHaveBeenCalledWith(
        "file://doc1",
        "MYDB",
      );
    });
  });

  describe("document isolation", () => {
    it("two providers with different URIs query their own cache partitions", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|USERS", {
        exists: true,
        table: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        columns: [{ name: "ID" }, { name: "NAME" }],
      });
      tableInfoMap.set("file://doc2|MYDB|ADMIN|USERS", {
        exists: true,
        table: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        columns: [{ name: "USER_ID" }, { name: "EMAIL" }],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider1 = new LspSchemaProvider(bridge, "file://doc1");
      const provider2 = new LspSchemaProvider(bridge, "file://doc2");

      const result1 = provider1.getTable("MYDB", "ADMIN", "USERS");
      const result2 = provider2.getTable("MYDB", "ADMIN", "USERS");

      expect(result1?.columns).toEqual([{ name: "ID" }, { name: "NAME" }]);
      expect(result2?.columns).toEqual([
        { name: "USER_ID" },
        { name: "EMAIL" },
      ]);

      expect(bridge.findCachedTableInfo).toHaveBeenCalledWith(
        "file://doc1",
        "USERS",
        "MYDB",
        "ADMIN",
      );
      expect(bridge.findCachedTableInfo).toHaveBeenCalledWith(
        "file://doc2",
        "USERS",
        "MYDB",
        "ADMIN",
      );
    });

    it("provider does not see data from another document's cache", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|MYDB|ADMIN|USERS", {
        exists: true,
        table: "USERS",
        database: "MYDB",
        schema: "ADMIN",
        columns: [{ name: "ID" }],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider1 = new LspSchemaProvider(bridge, "file://doc1");
      const provider2 = new LspSchemaProvider(bridge, "file://doc2");

      expect(provider1.getTable("MYDB", "ADMIN", "USERS")).toBeDefined();
      expect(provider2.getTable("MYDB", "ADMIN", "USERS")).toBeUndefined();
    });

    it("feeds column data types into SQL025 type comparison warnings", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc1|JUST_DATA||DIMACCOUNT", {
        exists: true,
        table: "DIMACCOUNT",
        database: "JUST_DATA",
        columns: [
          {
            name: "ACCOUNTCODEALTERNATEKEY",
            type: "INTEGER",
          },
        ],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider = new LspSchemaProvider(bridge, "file://doc1");
      const validator = new SqlValidator(provider);
      const result = validator.validate(
        "SELECT * FROM JUST_DATA..DIMACCOUNT A WHERE A.ACCOUNTCODEALTERNATEKEY = 'AAA'",
      );

      expect(result.warnings.some((warning) => warning.code === "SQL025")).toBe(
        true,
      );
    });

    it("tableExists returns permissive true for document with empty cache, false for document with known non-existent table", () => {
      const tableInfoMap = new Map<string, MetadataTableInfoResponse>();
      tableInfoMap.set("file://doc2|MYDB|ADMIN|GHOST", {
        exists: false,
        table: "GHOST",
        database: "MYDB",
        schema: "ADMIN",
        columns: [],
      });

      const bridge = createMockBridge(tableInfoMap);
      const provider1 = new LspSchemaProvider(bridge, "file://doc1");
      const provider2 = new LspSchemaProvider(bridge, "file://doc2");

      expect(provider1.tableExists("MYDB", "ADMIN", "GHOST")).toBe(true);
      expect(provider2.tableExists("MYDB", "ADMIN", "GHOST")).toBe(false);
    });
  });

  describe("proposeTableQualification", () => {
    it("returns cached qualification proposals from the bridge", () => {
      const qualificationMap = new Map<string, QualificationProposal[]>();
      qualificationMap.set("file://doc1|||USERS", [
        {
          database: "MYDB",
          schema: "ADMIN",
          name: "USERS",
          qualifiedText: "MYDB.ADMIN.USERS",
          isPreferred: true,
        },
      ]);

      const bridge = createMockBridge(
        new Map(),
        new Map(),
        false,
        qualificationMap,
      );
      const provider = new LspSchemaProvider(
        bridge,
        "file://doc1",
        "MYDB",
      );

      expect(provider.proposeTableQualification({ name: "USERS" })).toEqual([
        {
          database: "MYDB",
          schema: "ADMIN",
          name: "USERS",
          qualifiedText: "MYDB.ADMIN.USERS",
          isPreferred: true,
        },
      ]);
    });
  });
});
