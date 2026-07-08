/**
 * Tests for aliasResolver.ts
 */

import * as vscode from "vscode";
import {
  getCurrentSqlStatementRange,
  findAlias,
  getTableAndAliasBeforeCursor,
} from "../providers/matchers/aliasResolver";

jest.mock("vscode", () => ({
  Range: jest.fn().mockImplementation((start, end) => ({ start, end })),
  Position: jest
    .fn()
    .mockImplementation((line, char) => ({ line, character: char })),
}));

describe("providers/matchers/aliasResolver", () => {
  describe("getCurrentSqlStatementRange", () => {
    it("should return range for single statement", () => {
      const mockDocument = {
        getText: jest.fn().mockReturnValue("SELECT * FROM TABLE1"),
        offsetAt: jest.fn().mockReturnValue(10),
        positionAt: jest.fn().mockImplementation((offset: number) => ({
          line: 0,
          character: offset,
        })),
      } as unknown as vscode.TextDocument;

      const mockPosition = { line: 0, character: 5 } as vscode.Position;

      const result = getCurrentSqlStatementRange(mockDocument, mockPosition);

      expect(mockDocument.getText).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should find statement between semicolons", () => {
      const text = "SELECT * FROM T1; SELECT * FROM T2; SELECT * FROM T3;";
      const mockDocument = {
        getText: jest.fn().mockReturnValue(text),
        offsetAt: jest.fn().mockReturnValue(25), // Position in second statement
        positionAt: jest.fn().mockImplementation((offset: number) => ({
          line: 0,
          character: offset,
        })),
      } as unknown as vscode.TextDocument;

      const mockPosition = { line: 0, character: 25 } as vscode.Position;

      const result = getCurrentSqlStatementRange(mockDocument, mockPosition);

      expect(result).toBeDefined();
    });

    it("should handle statement at beginning of document", () => {
      const text = "SELECT * FROM TABLE1;";
      const mockDocument = {
        getText: jest.fn().mockReturnValue(text),
        offsetAt: jest.fn().mockReturnValue(0),
        positionAt: jest.fn().mockImplementation((offset: number) => ({
          line: 0,
          character: offset,
        })),
      } as unknown as vscode.TextDocument;

      const mockPosition = { line: 0, character: 0 } as vscode.Position;

      const result = getCurrentSqlStatementRange(mockDocument, mockPosition);

      expect(result).toBeDefined();
    });

    it("should handle statement at end of document without semicolon", () => {
      const text = "SELECT * FROM T1; SELECT * FROM T2";
      const mockDocument = {
        getText: jest.fn().mockReturnValue(text),
        offsetAt: jest.fn().mockReturnValue(25),
        positionAt: jest.fn().mockImplementation((offset: number) => ({
          line: 0,
          character: offset,
        })),
      } as unknown as vscode.TextDocument;

      const mockPosition = { line: 0, character: 25 } as vscode.Position;

      const result = getCurrentSqlStatementRange(mockDocument, mockPosition);

      expect(result).toBeDefined();
    });

    it("should handle empty document", () => {
      const mockDocument = {
        getText: jest.fn().mockReturnValue(""),
        offsetAt: jest.fn().mockReturnValue(0),
        positionAt: jest.fn().mockImplementation((offset: number) => ({
          line: 0,
          character: offset,
        })),
      } as unknown as vscode.TextDocument;

      const mockPosition = { line: 0, character: 0 } as vscode.Position;

      const result = getCurrentSqlStatementRange(mockDocument, mockPosition);

      expect(result).toBeDefined();
    });
  });

  describe("findAlias", () => {
    it("should find alias for FROM clause with explicit alias", () => {
      const text = "SELECT * FROM DB.SCHEMA.TABLE T WHERE T.ID = 1";
      const result = findAlias(text, "T");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE");
      expect(result?.schema).toBe("SCHEMA");
      expect(result?.db).toBe("DB");
    });

    it("should find alias with AS keyword", () => {
      const text = "SELECT * FROM TABLE1 AS T1";
      const result = findAlias(text, "T1");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE1");
    });

    it("should find table reference without explicit alias", () => {
      const text = "SELECT * FROM TABLE1";
      const result = findAlias(text, "TABLE1");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE1");
    });

    it("should return null for non-existent alias", () => {
      const text = "SELECT * FROM TABLE1 T";
      const result = findAlias(text, "X");

      expect(result).toBeNull();
    });

    it("should be case-insensitive", () => {
      const text = "SELECT * FROM TABLE1 t";
      const result = findAlias(text, "T");

      expect(result).not.toBeNull();
    });

    it("should find alias in JOIN clause", () => {
      const text = "SELECT * FROM TABLE1 T1 JOIN TABLE2 T2 ON T1.ID = T2.ID";
      const result = findAlias(text, "T2");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE2");
    });

    it("should return last match when multiple occurrences exist", () => {
      const text = "SELECT * FROM TABLE1 T JOIN TABLE2 T ON T.ID = 1";
      const result = findAlias(text, "T");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE2");
    });

    it("should handle schema.table reference", () => {
      const text = "SELECT * FROM SCHEMA.TABLE T";
      const result = findAlias(text, "T");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE");
      expect(result?.schema).toBe("SCHEMA");
    });

    it("should handle empty text", () => {
      const result = findAlias("", "T");

      expect(result).toBeNull();
    });

    it("should handle multi-line SQL", () => {
      const text = `
                SELECT * 
                FROM TABLE1 T
                WHERE T.ID = 1
            `;
      const result = findAlias(text, "T");

      expect(result).not.toBeNull();
      expect(result?.table).toBe("TABLE1");
    });
  });

  describe("getTableAndAliasBeforeCursor", () => {
    it("should extract single table reference", () => {
      const text = "SELECT * FROM TABLE1";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(1);
      expect(result[0].table).toBe("TABLE1");
      expect(result[0].alias).toBe("TABLE1");
    });

    it("should extract table with explicit alias", () => {
      const text = "SELECT * FROM TABLE1 T1";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(1);
      expect(result[0].table).toBe("TABLE1");
      expect(result[0].alias).toBe("T1");
    });

    it("should extract table with AS keyword", () => {
      const text = "SELECT * FROM TABLE1 AS T1";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(1);
      expect(result[0].table).toBe("TABLE1");
      expect(result[0].alias).toBe("T1");
    });

    it("should extract multiple table references", () => {
      const text = "SELECT * FROM TABLE1 T1 JOIN TABLE2 T2 ON T1.ID = T2.ID";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(2);
      expect(result[0].table).toBe("TABLE1");
      expect(result[0].alias).toBe("T1");
      expect(result[1].table).toBe("TABLE2");
      expect(result[1].alias).toBe("T2");
    });

    it("should handle fully qualified table names", () => {
      const text = "SELECT * FROM DB.SCHEMA.TABLE T";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(1);
      expect(result[0].db).toBe("DB");
      expect(result[0].schema).toBe("SCHEMA");
      expect(result[0].table).toBe("TABLE");
      expect(result[0].alias).toBe("T");
    });

    it("should handle schema.table reference", () => {
      const text = "SELECT * FROM SCHEMA.TABLE";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(1);
      expect(result[0].schema).toBe("SCHEMA");
      expect(result[0].table).toBe("TABLE");
    });

    it("should return empty array for no tables", () => {
      const text = "SELECT 1";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(0);
    });

    it("should handle empty text", () => {
      const result = getTableAndAliasBeforeCursor("");

      expect(result).toHaveLength(0);
    });

    it("should handle LEFT JOIN", () => {
      const text =
        "SELECT * FROM TABLE1 T1 LEFT JOIN TABLE2 T2 ON T1.ID = T2.ID";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(2);
      expect(result[1].table).toBe("TABLE2");
    });

    it("should handle INNER JOIN", () => {
      const text = "SELECT * FROM T1 INNER JOIN T2 ON T1.ID = T2.ID";
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(2);
      expect(result[0].table).toBe("T1");
      expect(result[1].table).toBe("T2");
    });

    it("should handle multiple JOINs", () => {
      const text = `
                SELECT * FROM TABLE1 T1
                JOIN TABLE2 T2 ON T1.ID = T2.ID
                JOIN TABLE3 T3 ON T2.ID = T3.ID
            `;
      const result = getTableAndAliasBeforeCursor(text);

      expect(result).toHaveLength(3);
      expect(result[0].alias).toBe("T1");
      expect(result[1].alias).toBe("T2");
      expect(result[2].alias).toBe("T3");
    });
  });
});
