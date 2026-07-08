/**
 * Unit tests for etl/utils/variableResolver.ts
 * Tests VariableResolver class and variable substitution
 */

import {
  VariableResolver,
  variableResolver,
} from "../../etl/utils/variableResolver";
import { IVariableResolver } from "../../etl/interfaces";

describe("VariableResolver", () => {
  let resolver: VariableResolver;

  beforeEach(() => {
    resolver = new VariableResolver();
  });

  describe("resolve", () => {
    it("should return template unchanged when no variables", () => {
      const template = "SELECT * FROM table";
      const result = resolver.resolve(template, { var1: "value" });

      expect(result).toBe(template);
    });

    it("should substitute single variable", () => {
      const template = "SELECT * FROM ${table}";
      const result = resolver.resolve(template, { table: "users" });

      expect(result).toBe("SELECT * FROM users");
    });

    it("should substitute multiple variables", () => {
      const template = "SELECT ${cols} FROM ${table} WHERE ${cond}";
      const result = resolver.resolve(template, {
        cols: "id, name",
        table: "users",
        cond: "active = 1",
      });

      expect(result).toBe("SELECT id, name FROM users WHERE active = 1");
    });

    it("should substitute same variable multiple times", () => {
      const template = "${db}.${schema}.table1, ${db}.${schema}.table2";
      const result = resolver.resolve(template, {
        db: "MYDB",
        schema: "PUBLIC",
      });

      expect(result).toBe("MYDB.PUBLIC.table1, MYDB.PUBLIC.table2");
    });

    it("should return template unchanged when variables object is empty", () => {
      const template = "SELECT * FROM ${table}";
      const result = resolver.resolve(template, {});

      expect(result).toBe(template);
    });

    it("should return template unchanged when variables is undefined", () => {
      const template = "SELECT * FROM ${table}";
      const result = resolver.resolve(
        template,
        undefined as unknown as Record<string, string>,
      );

      expect(result).toBe(template);
    });

    it("should return empty string when template is empty", () => {
      const result = resolver.resolve("", { var: "value" });

      expect(result).toBe("");
    });

    it("should return template when template is null/undefined", () => {
      const result1 = resolver.resolve(null as unknown as string, {
        var: "value",
      });
      const result2 = resolver.resolve(undefined as unknown as string, {
        var: "value",
      });

      expect(result1).toBeNull();
      expect(result2).toBeUndefined();
    });

    it("should handle special regex characters in variable names", () => {
      const template = "Value: ${var.name}";
      const result = resolver.resolve(template, { "var.name": "test" });

      expect(result).toBe("Value: test");
    });

    it("should handle special regex characters in variable values", () => {
      const template = "SELECT * FROM ${table}";
      const result = resolver.resolve(template, { table: "my$table" });

      expect(result).toBe("SELECT * FROM my$table");
    });

    it("should handle dollar signs in variable values", () => {
      const template = "Price: ${price}";
      const result = resolver.resolve(template, { price: "$100" });

      expect(result).toBe("Price: $100");
    });

    it("should handle empty variable value", () => {
      const template = 'Value: "${var}"';
      const result = resolver.resolve(template, { var: "" });

      expect(result).toBe('Value: ""');
    });

    it("should handle variable name with underscores", () => {
      const template = "SELECT * FROM ${my_table_name}";
      const result = resolver.resolve(template, { my_table_name: "users" });

      expect(result).toBe("SELECT * FROM users");
    });

    it("should substitute variable with braces only (no dollar sign)", () => {
      const template = "SELECT * FROM {table}";
      const result = resolver.resolve(template, { table: "users" });

      expect(result).toBe("SELECT * FROM users");
    });

    it("should substitute multiple variables with braces only", () => {
      const template = "SELECT {col1}, {col2} FROM {table}";
      const result = resolver.resolve(template, { col1: "id", col2: "name", table: "users" });

      expect(result).toBe("SELECT id, name FROM users");
    });

    it("should handle both ${var} and {var} formats together", () => {
      const template = "SELECT * FROM {table} WHERE id = ${id}";
      const result = resolver.resolve(template, { table: "users", id: "123" });

      expect(result).toBe("SELECT * FROM users WHERE id = 123");
    });

    it("should handle variable name with numbers", () => {
      const template = "Value: ${var123}";
      const result = resolver.resolve(template, { var123: "test" });

      expect(result).toBe("Value: test");
    });

    it("should not substitute variables that do not exist in variables map", () => {
      const template = "SELECT * FROM ${table} WHERE ${condition}";
      const result = resolver.resolve(template, { table: "users" });

      expect(result).toBe("SELECT * FROM users WHERE ${condition}");
    });

    it("should handle multiline templates", () => {
      const template = `SELECT *
FROM \${table}
WHERE id = \${id}`;
      const result = resolver.resolve(template, { table: "users", id: "123" });

      expect(result).toContain("FROM users");
      expect(result).toContain("id = 123");
    });

    it("should handle adjacent variables", () => {
      const template = "${prefix}${suffix}";
      const result = resolver.resolve(template, {
        prefix: "hello",
        suffix: "world",
      });

      expect(result).toBe("helloworld");
    });

    it("should handle variable at start and end", () => {
      const template = "${greeting} world ${punctuation}";
      const result = resolver.resolve(template, {
        greeting: "Hello",
        punctuation: "!",
      });

      expect(result).toBe("Hello world !");
    });
  });

  describe("resolveAll", () => {
    it("should resolve multiple templates", () => {
      const templates = ["SELECT * FROM ${table}", "SELECT id FROM ${table}"];
      const result = resolver.resolveAll(templates, { table: "users" });

      expect(result).toEqual(["SELECT * FROM users", "SELECT id FROM users"]);
    });

    it("should handle empty array", () => {
      const result = resolver.resolveAll([], { var: "value" });

      expect(result).toEqual([]);
    });

    it("should handle single template in array", () => {
      const result = resolver.resolveAll(["${greeting}"], {
        greeting: "Hello",
      });

      expect(result).toEqual(["Hello"]);
    });

    it("should handle templates with different variables", () => {
      const templates = ["${a}", "${b}", "${c}"];
      const result = resolver.resolveAll(templates, { a: "1", b: "2", c: "3" });

      expect(result).toEqual(["1", "2", "3"]);
    });

    it("should preserve template order", () => {
      const templates = ["${first}", "${second}", "${third}"];
      const result = resolver.resolveAll(templates, {
        first: "1",
        second: "2",
        third: "3",
      });

      expect(result[0]).toBe("1");
      expect(result[1]).toBe("2");
      expect(result[2]).toBe("3");
    });
  });

  describe("escapeRegex (private method - tested through resolve)", () => {
    it("should handle variable names with dots", () => {
      const template = "${db.schema.table}";
      const result = resolver.resolve(template, {
        "db.schema.table": "mytable",
      });

      expect(result).toBe("mytable");
    });

    it("should handle variable names with asterisks", () => {
      const template = "${var*name}";
      const result = resolver.resolve(template, { "var*name": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with plus signs", () => {
      const template = "${var+name}";
      const result = resolver.resolve(template, { "var+name": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with question marks", () => {
      const template = "${var?name}";
      const result = resolver.resolve(template, { "var?name": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with caret", () => {
      const template = "${var^name}";
      const result = resolver.resolve(template, { "var^name": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with parentheses", () => {
      const template = "${var(name)}";
      const result = resolver.resolve(template, { "var(name)": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with brackets", () => {
      const template = "${var[name]}";
      const result = resolver.resolve(template, { "var[name]": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with braces", () => {
      const template = "${var{name}}";
      const result = resolver.resolve(template, { "var{name}": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with pipe", () => {
      const template = "${var|name}";
      const result = resolver.resolve(template, { "var|name": "value" });

      expect(result).toBe("value");
    });

    it("should handle variable names with backslash", () => {
      const template = "${var\\name}";
      const result = resolver.resolve(template, { "var\\name": "value" });

      expect(result).toBe("value");
    });
  });
});

describe("IVariableResolver interface compliance", () => {
  let resolver: IVariableResolver;

  beforeEach(() => {
    resolver = new VariableResolver();
  });

  it("should implement resolve method", () => {
    expect(typeof resolver.resolve).toBe("function");
  });
});

describe("variableResolver singleton", () => {
  it("should be an instance of VariableResolver", () => {
    expect(variableResolver).toBeInstanceOf(VariableResolver);
  });

  it("should resolve variables", () => {
    const result = variableResolver.resolve("SELECT * FROM ${table}", {
      table: "users",
    });
    expect(result).toBe("SELECT * FROM users");
  });

  it("should resolve all templates", () => {
    const result = variableResolver.resolveAll(["${a}", "${b}"], {
      a: "1",
      b: "2",
    });
    expect(result).toEqual(["1", "2"]);
  });
});
