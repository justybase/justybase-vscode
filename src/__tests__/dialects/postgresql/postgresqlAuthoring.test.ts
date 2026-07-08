import { postgresqlCompatibleSqlAuthoring } from "../../../shared/sql-authoring/postgresql-compatible";

describe("postgresqlCompatibleSqlAuthoring", () => {
  it("registers first-class PostgreSQL builtins and types", () => {
    expect(
      postgresqlCompatibleSqlAuthoring.validation.builtinFunctions.has(
        "GENERATE_SERIES",
      ),
    ).toBe(true);
    expect(
      postgresqlCompatibleSqlAuthoring.validation.builtinFunctions.has(
        "JSONB_BUILD_OBJECT",
      ),
    ).toBe(true);
    expect(
      postgresqlCompatibleSqlAuthoring.validation.getTypeSpec("jsonb")
        ?.canonical,
    ).toBe("JSONB");
    expect(
      postgresqlCompatibleSqlAuthoring.validation.getTypeSpec("timestamptz")
        ?.canonical,
    ).toBe("TIMESTAMPTZ");
    expect(
      postgresqlCompatibleSqlAuthoring.validation.getTypeSpec("serial")
        ?.canonical,
    ).toBe("SERIAL");
  });

  it("exposes PostgreSQL-specific completion keywords and signatures", () => {
    expect(postgresqlCompatibleSqlAuthoring.completionKeywords).toEqual(
      expect.arrayContaining([
        "COPY",
        "EXPLAIN",
        "ON CONFLICT",
        "MATERIALIZED VIEW",
      ]),
    );
    expect(
      postgresqlCompatibleSqlAuthoring.signatures.has("GENERATE_SERIES"),
    ).toBe(true);
    expect(postgresqlCompatibleSqlAuthoring.signatures.has("STRING_AGG")).toBe(
      true,
    );
  });
});
