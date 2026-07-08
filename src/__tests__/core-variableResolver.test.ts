import * as vscode from "vscode";
import {
  collectQueryVariableValues,
  promptForVariableValues,
  resolveQueryVariables,
} from "../core/variableResolver";
import { VariableInputWebviewPanel } from "../views/variableInputWebviewPanel";
import {
  extractVariables,
  parseSetVariables,
  replaceVariablesInSql,
} from "../core/variableUtils";

jest.mock("../views/variableInputWebviewPanel");
jest.mock("../core/variableUtils", () => {
  const actual = jest.requireActual("../core/variableUtils");
  return {
    ...actual,
    extractVariables: jest.fn(),
    parseSetVariables: jest.fn(),
    replaceVariablesInSql: jest.fn(),
  };
});

const mockedVariableInputWebviewPanel = VariableInputWebviewPanel as jest.Mocked<
  typeof VariableInputWebviewPanel
>;
const mockedExtractVariables = extractVariables as jest.MockedFunction<
  typeof extractVariables
>;
const mockedParseSetVariables = parseSetVariables as jest.MockedFunction<
  typeof parseSetVariables
>;
const mockedReplaceVariablesInSql =
  replaceVariablesInSql as jest.MockedFunction<typeof replaceVariablesInSql>;

describe("core/variableResolver", () => {
  let mockContext: jest.Mocked<vscode.ExtensionContext>;
  let mockGlobalState: jest.Mocked<vscode.Memento>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockGlobalState = {
      get: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<vscode.Memento>;

    mockContext = {
      globalState: mockGlobalState,
    } as unknown as jest.Mocked<vscode.ExtensionContext>;
  });

  describe("promptForVariableValues", () => {
    it("should return empty object when no variables", async () => {
      const result = await promptForVariableValues(
        new Set(),
        false,
        {},
        mockContext,
      );

      expect(result).toEqual({});
    });

    it("should use default values when silent mode", async () => {
      const variables = new Set(["var1", "var2"]);
      const defaults = { var1: "value1", var2: "value2" };

      const result = await promptForVariableValues(
        variables,
        true,
        defaults,
        mockContext,
      );

      expect(result).toEqual({ VAR1: "value1", VAR2: "value2" });
    });

    it("should throw error in silent mode when variables missing defaults", async () => {
      const variables = new Set(["var1", "var2"]);
      const defaults = { var1: "value1" };

      await expect(
        promptForVariableValues(variables, true, defaults, mockContext),
      ).rejects.toThrow("Query contains variables but silent mode is enabled");
    });

    it("should prompt for values using VariableInputPanel", async () => {
      const variables = new Set(["var1"]);
      const expectedValues = { VAR1: "promptedValue" };

      mockedVariableInputWebviewPanel.show.mockResolvedValue(expectedValues);

      const result = await promptForVariableValues(
        variables,
        false,
        {},
        mockContext,
      );

      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalledWith(
        expect.arrayContaining(["VAR1"]),
        {},
        mockContext,
      );
      expect(result).toEqual(expectedValues);
    });

    it("should throw error when user cancels input", async () => {
      const variables = new Set(["var1"]);

      mockedVariableInputWebviewPanel.show.mockResolvedValue(undefined);

      await expect(
        promptForVariableValues(variables, false, {}, mockContext),
      ).rejects.toThrow("Variable input cancelled by user");
    });

    it("should use previous values from context when available", async () => {
      const variables = new Set(["var1"]);
      const previousValues = { var1: ["previousValue"] };

      mockGlobalState.get.mockReturnValue(previousValues);
      mockedVariableInputWebviewPanel.show.mockResolvedValue({ VAR1: "newValue" });

      await promptForVariableValues(variables, false, {}, mockContext);

      expect(mockGlobalState.get).toHaveBeenCalledWith(
        "justybase.variableValues",
      );
      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalledWith(
        expect.arrayContaining(["VAR1"]),
        { VAR1: "previousValue" },
        mockContext,
      );
    });

    it("should prefer defaults over previous values", async () => {
      const variables = new Set(["var1"]);
      const defaults = { var1: "defaultValue" };
      const previousValues = { var1: ["previousValue"] };

      mockGlobalState.get.mockReturnValue(previousValues);
      mockedVariableInputWebviewPanel.show.mockResolvedValue({ VAR1: "newValue" });

      await promptForVariableValues(variables, false, defaults, mockContext);

      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalledWith(
        expect.arrayContaining(["VAR1"]),
        { VAR1: "defaultValue" },
        mockContext,
      );
    });

    it("should handle undefined context gracefully", async () => {
      const variables = new Set(["var1"]);

      mockedVariableInputWebviewPanel.show.mockResolvedValue({ VAR1: "value" });

      const result = await promptForVariableValues(
        variables,
        false,
        {},
        undefined,
      );

      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalledWith(
        expect.arrayContaining(["VAR1"]),
        {},
        undefined,
      );
      expect(result).toEqual({ VAR1: "value" });
    });

    it("should not require query context when scanning %SQL inside %LET", async () => {
      const query = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);`;

      const result = await collectQueryVariableValues(query, false, mockContext);

      expect(result).toEqual({});
      expect(mockedVariableInputWebviewPanel.show).not.toHaveBeenCalled();
    });

    it("should deduplicate variables case-insensitively before prompting", async () => {
      const variables = new Set(["VAR", "vAr"]);

      mockedVariableInputWebviewPanel.show.mockResolvedValue({ VAR: "value" });

      const result = await promptForVariableValues(
        variables,
        false,
        { var: "defaultValue" },
        mockContext,
      );

      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalledWith(
        ["VAR"],
        { VAR: "defaultValue" },
        mockContext,
      );
      expect(result).toEqual({ VAR: "value" });
    });
  });

  describe("resolveQueryVariables", () => {
    it("should resolve query with inline variables", async () => {
      const query = "%let id = 123;\nSELECT * FROM table WHERE id = ${id}";

      const result = await resolveQueryVariables(query, true, mockContext);

      expect(result).toBe("SELECT * FROM table WHERE id = 123");
      expect(mockedVariableInputWebviewPanel.show).not.toHaveBeenCalled();
    });

    it("should prompt for missing variables", async () => {
      const query = "%let id = 123;\nSELECT * FROM table WHERE id = ${id} AND name = ${name}";
      mockedVariableInputWebviewPanel.show.mockResolvedValue({ name: "John" });

      const result = await resolveQueryVariables(query, false, mockContext);

      expect(mockedVariableInputWebviewPanel.show).toHaveBeenCalled();
      expect(result).toBe("SELECT * FROM table WHERE id = 123 AND name = John");
    });

    it("should not prompt for variables declared by %let", async () => {
      const query = "%let points_cutoff = 20;\nSELECT * FROM scores WHERE points > &points_cutoff";

      const result = await resolveQueryVariables(query, false, mockContext);

      expect(mockedVariableInputWebviewPanel.show).not.toHaveBeenCalled();
      expect(result).toBe("SELECT * FROM scores WHERE points > 20");
    });

    it("should merge inline and prompted values", async () => {
      const query = "%let a = inlineA;\nSELECT ${a}, ${b}";
      mockedVariableInputWebviewPanel.show.mockResolvedValue({ b: "promptedB" });

      const result = await resolveQueryVariables(query, false, mockContext);

      expect(result).toBe("SELECT inlineA, promptedB");
    });

    it("should handle query with no variables", async () => {
      const query = "SELECT * FROM table";
      const parsed = {
        sql: "SELECT * FROM table",
        setValues: {},
      };

      mockedParseSetVariables.mockReturnValue(parsed);
      mockedExtractVariables.mockReturnValue(new Set());
      mockedReplaceVariablesInSql.mockReturnValue("SELECT * FROM table");

      const result = await resolveQueryVariables(query, false, mockContext);

      expect(result).toBe("SELECT * FROM table");
      expect(mockedVariableInputWebviewPanel.show).not.toHaveBeenCalled();
    });

    it("should handle undefined context", async () => {
      const query = "SELECT ${var}";
      const parsed = {
        sql: "SELECT ${var}",
        setValues: {},
      };

      mockedParseSetVariables.mockReturnValue(parsed);
      mockedExtractVariables.mockReturnValue(new Set(["var"]));
      mockedVariableInputWebviewPanel.show.mockResolvedValue({ var: "value" });
      mockedReplaceVariablesInSql.mockReturnValue("SELECT value");

      const result = await resolveQueryVariables(query, false, undefined);

      expect(result).toBe("SELECT value");
    });

    it("should emit %PUT messages through the log callback", async () => {
      const query = "%let sum = 8;\n%PUT Sum is &sum;";
      const logCallback = jest.fn();

      await resolveQueryVariables(query, false, mockContext, logCallback);

      expect(logCallback).toHaveBeenCalledWith(">>> %PUT: Sum is 8");
    });

    it("should resolve %PUT messages after prompting for missing variables", async () => {
      const query = "%PUT id=&id;\nSELECT &id;";
      const logCallback = jest.fn();

      mockedVariableInputWebviewPanel.show.mockResolvedValue({ id: "42" });

      const result = await resolveQueryVariables(query, false, mockContext, logCallback);

      expect(result).toBe("SELECT 42;");
      expect(logCallback).toHaveBeenCalledWith(">>> %PUT: id=42");
    });

    it("should not replace macro markers inside strings or comments", async () => {
      const query = "%let id = 42;\nSELECT '&id' AS literal, &id AS value -- &id comment";

      const result = await resolveQueryVariables(query, false, mockContext);

      expect(result).toBe("SELECT '&id' AS literal, 42 AS value -- &id comment");
    });
  });
});
