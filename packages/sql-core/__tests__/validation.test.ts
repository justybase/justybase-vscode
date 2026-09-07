import {
  NetezzaSqlSemanticValidator,
  type SchemaProvider,
} from "../src/validation";

describe("NetezzaSqlSemanticValidator", () => {
  const schema: SchemaProvider = {
    getTable: (_database, _schema, name) =>
      name.toUpperCase() === "ORDERS"
        ? {
            name: "ORDERS",
            database: "DB",
            schema: "PUBLIC",
            isCte: false,
            isTempTable: false,
            columns: [
              { name: "ORDER_ID", dataType: "INTEGER" },
              { name: "DESCRIPTION", dataType: "VARCHAR(80)" },
            ],
          }
        : undefined,
    tableExists: (database, schemaName, name) =>
      name.toUpperCase() === "ORDERS" &&
      database === "DB" &&
      schemaName === "PUBLIC",
  };

  it("owns type-aware semantic diagnostics and scope construction", () => {
    const result = new NetezzaSqlSemanticValidator(schema).validate(
      "SELECT ORDER_ID FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1' AND DESCRIPTION > 10",
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["SQL025", "SQL026"]),
    );
    expect(result.scope.level).toBe(0);
  });

  it.each([
    "%put 😀;\nSELECT FROM;",
    "%include \"😀.sql\";\nSELECT FROM;",
    "%if 1 %then %do;\n%put 😀;\n%end;\nSELECT FROM;",
  ])("keeps UTF-16 positions after masked macro directives: %s", (sql) => {
    const result = new NetezzaSqlSemanticValidator().validate(sql);
    const parserError = result.errors.find((error) => error.code === "PAR001");

    expect(parserError).toBeDefined();
    expect(parserError?.position.offset).toBe(
      sql.indexOf("SELECT") + "SELECT".length - 1,
    );
  });

  it("preserves EOF trailing-dot recovery while reporting a dot before a clause", () => {
    const validator = new NetezzaSqlSemanticValidator();

    expect(validator.validate("SELECT T.").errors).toEqual([]);
    expect(
      validator.validate("SELECT T. FROM DB.PUBLIC.ORDERS T").errors,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PAR001" })]),
    );
  });

  it("exposes the method-shaped unqualified-table capability", () => {
    const calls: string[] = [];
    const provider: SchemaProvider = {
      ...schema,
      getTable: (database, schemaName, name) =>
        database && schemaName ? schema.getTable(database, schemaName, name) : undefined,
      tableExists: (_database, _schemaName, name) => name.toUpperCase() === "ORDERS",
      canValidateUnqualifiedTableReferences: () => {
        calls.push("called");
        return true;
      },
    };

    new NetezzaSqlSemanticValidator(provider).validate("SELECT * FROM ORDERS");
    expect(calls).toContain("called");
  });
});
