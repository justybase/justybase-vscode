jest.unmock("chevrotain");

import { parseSqlStatements } from "../../sqlParser/parsingRuntime";
import {
  toNetezzaParseResult,
  toNetezzaSchemaProvider,
  toNetezzaStatementBoundaries,
} from "../../sqlParser/sqlCoreAdapter";
import type { TableInfo } from "../../sqlParser/types";

describe("sql-core desktop adapter", () => {
  it("maps the complete desktop schema contract without losing metadata", () => {
    const table: TableInfo = {
      name: "ORDERS",
      database: "DB",
      schema: "PUBLIC",
      alias: "O",
      isCte: false,
      isTempTable: false,
      columns: [{
        name: "ORDER_ID",
        dataType: "INTEGER",
        isDistributionKey: true,
        position: {
          startLine: 2,
          startColumn: 3,
          endLine: 2,
          endColumn: 11,
          offset: 10,
        },
      }],
      position: {
        startLine: 1,
        startColumn: 15,
        endLine: 1,
        endColumn: 30,
        offset: 14,
      },
    };
    const qualificationCalls: Array<{ database?: string; schema?: string; name: string }> = [];
    const provider = toNetezzaSchemaProvider({
      getTable: () => table,
      tableExists: () => true,
      proposeTableQualification: (request) => {
        qualificationCalls.push(request);
        return [{
          database: "DB",
          schema: "PUBLIC",
          name: request.name,
          qualifiedText: "DB.PUBLIC.ORDERS",
          isPreferred: true,
        }];
      },
      canValidateUnqualifiedTableReferences: () => true,
      getTablesInSchema: () => [table],
      getDatabases: () => ["DB"],
      getKnownFunctions: () => new Set(["CUSTOM_FN"]),
    });

    expect(provider).toBeDefined();
    expect(provider?.getTable("DB", "PUBLIC", "ORDERS")).toEqual({
      ...table,
      columns: [{ ...table.columns[0] }],
    });
    expect(provider?.tableExists("DB", "PUBLIC", "ORDERS")).toBe(true);
    expect(provider?.canValidateUnqualifiedTableReferences?.()).toBe(true);
    expect(provider?.getTablesInSchema?.("DB", "PUBLIC")).toHaveLength(1);
    expect(provider?.getDatabases?.()).toEqual(["DB"]);
    expect(provider?.getKnownFunctions?.()).toEqual(new Set(["CUSTOM_FN"]));
    expect(provider?.proposeTableQualification?.({ name: "ORDERS" })).toEqual([{
      database: "DB",
      schema: "PUBLIC",
      name: "ORDERS",
      qualifiedText: "DB.PUBLIC.ORDERS",
      isPreferred: true,
    }]);
    expect(qualificationCalls).toEqual([{ name: "ORDERS" }]);
  });

  it("maps desktop statement boundaries without leaking desktop cache fields", () => {
    expect(toNetezzaStatementBoundaries([{
      index: 2,
      startOffset: 10,
      endOffset: 20,
      sql: "SELECT 1",
      contentHash: "cached-hash",
    }])).toEqual([{
      index: 2,
      startOffset: 10,
      endOffset: 20,
      sql: "SELECT 1",
    }]);
  });

  it("rejects parse results produced by a different dialect runtime", () => {
    const sqliteParseResult = parseSqlStatements({ sql: "SELECT 1", databaseKind: "sqlite" });

    expect(() => toNetezzaParseResult(sqliteParseResult)).toThrow(
      "Netezza validation cannot consume sqlite parse results.",
    );
  });
});
