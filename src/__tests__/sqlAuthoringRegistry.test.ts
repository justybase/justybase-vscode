import { DEFAULT_DATABASE_KIND } from "../contracts/database";
import { getDatabaseDialectByKind } from "../core/factories/databaseDialectRegistry";
import {
  getDatabaseSqlAuthoring,
  tryGetDatabaseSqlAuthoring,
} from "../core/connectionFactory";
import {
  __TEST_ONLY_resetBuiltInDialectsRegistration,
  ensureBuiltInDialectsRegistered,
} from "../dialects";
import { netezzaSqlAuthoring } from "../dialects/netezza/sql/authoring";
import { sqliteDialect } from "../dialects/sqlite";
import { oracleSqlAuthoring } from "../../extensions/oracle/src/sql/authoring";
import { mysqlSqlAuthoring } from "../../extensions/mysql/src/sql/authoring";
import { postgresqlCompatibleSqlAuthoring } from "../shared/sql-authoring/postgresql-compatible";
import { __TEST_ONLY_resetDatabaseDialectRegistry } from "../core/factories/databaseDialectRegistry";
import { resetDatabaseDialectTestingState } from "./dialectTestUtils";

describe("sqlAuthoringRegistry", () => {
  beforeEach(() => {
    resetDatabaseDialectTestingState();
    __TEST_ONLY_resetDatabaseDialectRegistry();
    __TEST_ONLY_resetBuiltInDialectsRegistration();
    ensureBuiltInDialectsRegistered();
  });

  it("returns the default authoring profile when no kind is provided", () => {
    expect(getDatabaseSqlAuthoring()).toBe(netezzaSqlAuthoring);
    expect(getDatabaseSqlAuthoring(DEFAULT_DATABASE_KIND)).toBe(
      netezzaSqlAuthoring,
    );
  });

  it("returns sqlite authoring from the built-in dialect", () => {
    const resolvedAuthoring = getDatabaseSqlAuthoring("sqlite");
    expect(getDatabaseDialectByKind("sqlite")).toBe(sqliteDialect);
    expect(resolvedAuthoring).toBe(sqliteDialect.sqlAuthoring);
    expect(resolvedAuthoring).not.toBe(netezzaSqlAuthoring);
  });

  it("returns optional dialect authoring without requiring runtime dialect registration", () => {
    expect(getDatabaseSqlAuthoring("oracle")).toBe(oracleSqlAuthoring);
    expect(getDatabaseSqlAuthoring("postgresql")).toBe(
      postgresqlCompatibleSqlAuthoring,
    );
    expect(getDatabaseSqlAuthoring("mysql")).toBe(mysqlSqlAuthoring);
  });

  it("returns authoring from the non-throwing lookup helper for optional dialects", () => {
    expect(tryGetDatabaseSqlAuthoring("oracle")).toBe(oracleSqlAuthoring);
    expect(tryGetDatabaseSqlAuthoring("postgresql")).toBe(
      postgresqlCompatibleSqlAuthoring,
    );
    expect(tryGetDatabaseSqlAuthoring("mysql")).toBe(mysqlSqlAuthoring);
  });

  it("still throws for unsupported kinds", () => {
    expect(() => getDatabaseSqlAuthoring("unknown-db")).toThrow(
      "Unsupported database kind",
    );
    expect(tryGetDatabaseSqlAuthoring("unknown-db")).toBeUndefined();
  });

  it("returns authoring for registered built-in dialects", () => {
    expect(getDatabaseSqlAuthoring("netezza")).toBe(netezzaSqlAuthoring);
    expect(getDatabaseSqlAuthoring("sqlite")).toBe(sqliteDialect.sqlAuthoring);
  });
});
