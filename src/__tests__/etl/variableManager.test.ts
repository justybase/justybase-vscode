/**
 * Unit tests for etl/utils/variableManager.ts
 * Tests VariableManager class and IVariableManager interface
 */

import {
  VariableManager,
  IVariableManager,
} from "../../etl/utils/variableManager";

jest.mock("vscode", () => ({
  window: {
    showInputBox: jest.fn(),
  },
}));

import * as vscode from "vscode";

describe("VariableManager", () => {
  let manager: VariableManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new VariableManager();
  });

  describe("constructor", () => {
    it("should create empty manager when no initial variables", () => {
      const mgr = new VariableManager();
      expect(mgr.getAll()).toEqual({});
    });

    it("should initialize with provided variables", () => {
      const initial = { var1: "value1", var2: "value2" };
      const mgr = new VariableManager(initial);
      expect(mgr.getAll()).toEqual(initial);
    });

    it("should handle empty initial variables object", () => {
      const mgr = new VariableManager({});
      expect(mgr.getAll()).toEqual({});
    });

    it("should handle undefined initial variables", () => {
      const mgr = new VariableManager(undefined);
      expect(mgr.getAll()).toEqual({});
    });
  });

  describe("get", () => {
    it("should return undefined for non-existent variable", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("should return value for existing variable", () => {
      manager.set("test", "value");
      expect(manager.get("test")).toBe("value");
    });

    it("should return empty string value", () => {
      manager.set("empty", "");
      expect(manager.get("empty")).toBe("");
    });

    it("should handle special characters in variable name", () => {
      manager.set("var-with-dash", "value");
      expect(manager.get("var-with-dash")).toBe("value");
    });
  });

  describe("set", () => {
    it("should set a new variable", () => {
      manager.set("newVar", "newValue");
      expect(manager.get("newVar")).toBe("newValue");
    });

    it("should overwrite existing variable", () => {
      manager.set("var", "original");
      manager.set("var", "updated");
      expect(manager.get("var")).toBe("updated");
    });

    it("should handle complex string values", () => {
      const complexValue = "SELECT * FROM table WHERE id = ${id}";
      manager.set("query", complexValue);
      expect(manager.get("query")).toBe(complexValue);
    });
  });

  describe("has", () => {
    it("should return false for non-existent variable", () => {
      expect(manager.has("nonexistent")).toBe(false);
    });

    it("should return true for existing variable", () => {
      manager.set("test", "value");
      expect(manager.has("test")).toBe(true);
    });

    it("should return true for variable with empty string value", () => {
      manager.set("empty", "");
      expect(manager.has("empty")).toBe(true);
    });
  });

  describe("getAll", () => {
    it("should return empty object for empty manager", () => {
      expect(manager.getAll()).toEqual({});
    });

    it("should return all variables as object", () => {
      manager.set("var1", "value1");
      manager.set("var2", "value2");
      expect(manager.getAll()).toEqual({ var1: "value1", var2: "value2" });
    });

    it("should return copy of variables (not reference)", () => {
      manager.set("var", "value");
      const all = manager.getAll();
      all["var"] = "modified";
      expect(manager.get("var")).toBe("value");
    });
  });

  describe("snapshot", () => {
    it("should return copy of current variables", () => {
      manager.set("var1", "value1");
      const snapshot = manager.snapshot();
      expect(snapshot).toEqual({ var1: "value1" });
    });

    it("should not affect manager when snapshot is modified", () => {
      manager.set("var", "original");
      const snapshot = manager.snapshot();
      snapshot["var"] = "modified";
      expect(manager.get("var")).toBe("original");
    });

    it("should return empty object for empty manager", () => {
      expect(manager.snapshot()).toEqual({});
    });
  });

  describe("merge", () => {
    it("should add new variables from merge", () => {
      manager.set("existing", "value");
      manager.merge({ newVar: "newValue" });
      expect(manager.get("existing")).toBe("value");
      expect(manager.get("newVar")).toBe("newValue");
    });

    it("should overwrite existing variables on merge", () => {
      manager.set("var", "original");
      manager.merge({ var: "merged" });
      expect(manager.get("var")).toBe("merged");
    });

    it("should handle empty merge object", () => {
      manager.set("var", "value");
      manager.merge({});
      expect(manager.get("var")).toBe("value");
    });

    it("should merge multiple variables", () => {
      manager.set("a", "1");
      manager.merge({ b: "2", c: "3", d: "4" });
      expect(manager.getAll()).toEqual({ a: "1", b: "2", c: "3", d: "4" });
    });
  });

  describe("promptForValue", () => {
    it("should show input box and return value", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("userInput");

      const result = await manager.promptForValue("testVar", "Enter value:");

      expect(result).toBe("userInput");
      expect(manager.get("testVar")).toBe("userInput");
    });

    it("should show input box with default value", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("inputValue");

      await manager.promptForValue("var", "Message", "defaultVal");

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: "defaultVal" }),
      );
    });

    it("should return undefined when user cancels", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const result = await manager.promptForValue("var", "Enter value:");

      expect(result).toBeUndefined();
      expect(manager.has("var")).toBe(false);
    });

    it("should use default message when message is empty", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("value");

      await manager.promptForValue("myVar", "");

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Enter value for myVar" }),
      );
    });

    it("should set ignoreFocusOut to true", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("value");

      await manager.promptForValue("var", "Message");

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ ignoreFocusOut: true }),
      );
    });

    it("should use empty string as default when no default provided", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("value");

      await manager.promptForValue("var", "Message");

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({ value: "" }),
      );
    });

    it("should handle empty string input", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue("");

      const result = await manager.promptForValue("var", "Message");

      expect(result).toBe("");
      expect(manager.get("var")).toBe("");
    });
  });
});

describe("IVariableManager interface compliance", () => {
  let manager: IVariableManager;

  beforeEach(() => {
    manager = new VariableManager();
  });

  it("should implement get method", () => {
    expect(typeof manager.get).toBe("function");
  });

  it("should implement set method", () => {
    expect(typeof manager.set).toBe("function");
  });

  it("should implement has method", () => {
    expect(typeof manager.has).toBe("function");
  });

  it("should implement getAll method", () => {
    expect(typeof manager.getAll).toBe("function");
  });

  it("should implement promptForValue method", () => {
    expect(typeof manager.promptForValue).toBe("function");
  });
});
