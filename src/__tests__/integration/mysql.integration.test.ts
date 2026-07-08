import { MysqlConnection } from "../../../extensions/mysql/src/mysqlConnection";
import { mysqlMetadataProvider } from "../../../extensions/mysql/src/mysqlSchemaProvider";
import { mysqlDialect } from "../../../extensions/mysql/src/mysqlDialect";
import {
  buildMysqlExplainQuery,
  isMysqlExplainJson,
  parseMysqlExplainJson,
  parseMysqlExplainText,
  renderMysqlExplainPlan,
} from "../../../extensions/mysql/src/mysqlExplainParser";
import { MysqlTuningAdvisor } from "../../../extensions/mysql/src/mysqlTuningAdvisor";
import { registerDatabaseDialect } from "../../core/factories/databaseDialectRegistry";
import type { DatabaseConnectionConfig } from "../../contracts/database";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function buildConfig(): DatabaseConnectionConfig | undefined {
  const explicitRunFlag = (
    process.env.RUN_MYSQL_INTEGRATION ||
    process.env.MYSQL_LIVE_TEST_ENABLED ||
    ""
  )
    .trim()
    .toLowerCase();
  if (!["1", "true", "yes"].includes(explicitRunFlag)) {
    return undefined;
  }

  const host = readEnv("MYSQL_LIVE_TEST_HOST");
  const database = readEnv("MYSQL_LIVE_TEST_DATABASE");
  const user = readEnv("MYSQL_LIVE_TEST_USER");
  const password = readEnv("MYSQL_LIVE_TEST_PASSWORD");

  if (!host || !database || !user || !password) {
    return undefined;
  }

  return {
    host,
    database,
    user,
    password,
    port: Number(process.env.MYSQL_LIVE_TEST_PORT || 3306),
  };
}

async function readRows(
  connection: MysqlConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await connection.createCommand(sql).executeReader();
  try {
    const rows: Record<string, unknown>[] = [];
    while (await reader.read()) {
      const row: Record<string, unknown> = {};
      for (let index = 0; index < reader.fieldCount; index += 1) {
        row[reader.getName(index)] = reader.getValue(index);
      }
      rows.push(row);
    }
    return rows;
  } finally {
    await reader.close();
  }
}

async function readScalar(
  connection: MysqlConnection,
  sql: string,
): Promise<unknown> {
  const reader = await connection.createCommand(sql).executeReader();
  try {
    expect(await reader.read()).toBe(true);
    return reader.getValue(0);
  } finally {
    await reader.close();
  }
}

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

const config = buildConfig();
const describeIfConfigured = config ? describe : describe.skip;

if (config) {
  registerDatabaseDialect(mysqlDialect);
}

describeIfConfigured("mysql integration", () => {
  let connection: MysqlConnection;

  beforeAll(async () => {
    connection = new MysqlConnection(config!);
    await connection.connect();
  }, 60000);

  afterAll(async () => {
    await connection.close();
  });

  describe("connection and basic queries", () => {
    it("connects and returns current database context", async () => {
      const currentDb = await readScalar(
        connection,
        "SELECT DATABASE() AS CURRENT_CATALOG",
      );
      expect(typeof currentDb).toBe("string");
      expect(String(currentDb).length).toBeGreaterThan(0);
    });

    it("executes a simple SELECT query", async () => {
      const rows = await readRows(connection, "SELECT 1 AS SAMPLE_VALUE");
      expect(rows.length).toBe(1);
      expect(rows[0].SAMPLE_VALUE).toBe(1);
    });

    it("returns session context information", async () => {
      const reader = await connection
        .createCommand(
          "SELECT DATABASE() AS CURRENT_CATALOG, DATABASE() AS CURRENT_SCHEMA, CONNECTION_ID() AS CURRENT_SID",
        )
        .executeReader();
      try {
        expect(await reader.read()).toBe(true);
        expect(String(reader.getValue(0)).length).toBeGreaterThan(0);
        expect(String(reader.getValue(1)).length).toBeGreaterThan(0);
        expect(Number(reader.getValue(2))).toBeGreaterThan(0);
      } finally {
        await reader.close();
      }
    });
  });

  describe("metadata provider", () => {
    it("lists databases using metadata provider", async () => {
      const rows = await readRows(
        connection,
        mysqlMetadataProvider.buildListDatabasesQuery(),
      );
      expect(rows.length).toBeGreaterThan(0);
      const databaseNames = rows.map((row) => row.DATABASE).filter(Boolean);
      expect(databaseNames.length).toBeGreaterThan(0);
    });

    it("lists schemas for the configured database", async () => {
      const rows = await readRows(
        connection,
        mysqlMetadataProvider.buildListSchemasQuery(config!.database),
      );
      expect(rows.length).toBeGreaterThan(0);
      const schemaNames = rows.map((row) => row.SCHEMA).filter(Boolean);
      expect(schemaNames.length).toBeGreaterThan(0);
    });

    it("lists tables for the configured database", async () => {
      const rows = await readRows(
        connection,
        mysqlMetadataProvider.buildListTablesQuery(
          config!.database,
          config!.database,
        ),
      );
      expect(Array.isArray(rows)).toBe(true);
    });

    it("lists views for the configured database", async () => {
      const rows = await readRows(
        connection,
        mysqlMetadataProvider.buildListViewsQuery(
          config!.database,
          config!.database,
        ),
      );
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe("DDL provider", () => {
    let testTableName: string;
    let testSchema: string;

    beforeAll(async () => {
      testSchema = config!.database;
      testTableName = `jbl_mysql_test_${Date.now()}`;
      await connection
        .createCommand(
          `CREATE TABLE ${quoteIdentifier(testSchema)}.${quoteIdentifier(testTableName)} (` +
            `id INT PRIMARY KEY AUTO_INCREMENT, ` +
            `name VARCHAR(100) NOT NULL, ` +
            `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` +
            `) ENGINE=InnoDB`,
        )
        .execute();
    });

    afterAll(async () => {
      await connection
        .createCommand(
          `DROP TABLE IF EXISTS ${quoteIdentifier(testSchema)}.${quoteIdentifier(testTableName)}`,
        )
        .execute();
    });

    it("retrieves column metadata for a table", async () => {
      const columns = await mysqlDialect.advancedFeatures!.ddl!.getColumns(
        connection,
        config!.database,
        testSchema,
        testTableName,
      );
      expect(columns.length).toBeGreaterThan(0);
      const idColumn = columns.find((col) => col.name === "id");
      expect(idColumn).toBeDefined();
      expect(idColumn!.notNull).toBe(true);
    });

    it("retrieves keys info for a table", async () => {
      const keysInfo = await mysqlDialect.advancedFeatures!.ddl!.getKeysInfo(
        connection,
        config!.database,
        testSchema,
        testTableName,
      );
      expect(keysInfo).toBeInstanceOf(Map);
      expect(keysInfo.size).toBeGreaterThan(0);
      const pkEntry = [...keysInfo.values()].find(
        (key) => key.typeChar === "P",
      );
      expect(pkEntry).toBeDefined();
      expect(pkEntry!.columns).toContain("id");
    });

    it("generates table DDL", async () => {
      const ddl = await mysqlDialect.advancedFeatures!.ddl!.generateTableDDL(
        connection,
        config!.database,
        testSchema,
        testTableName,
      );
      expect(ddl).toContain("CREATE TABLE");
      expect(ddl).toContain(testTableName);
    });

    it("builds table stats query", async () => {
      const statsQuery =
        mysqlDialect.advancedFeatures!.ddl!.buildTableStatsQuery(
          config!.database,
          testSchema,
          testTableName,
        );
      const rows = await readRows(connection, statsQuery);
      expect(rows.length).toBe(1);
      expect(rows[0]).toHaveProperty("ROW_COUNT");
    });
  });

  describe("explain plan parser", () => {
    it("parses EXPLAIN FORMAT=JSON output", async () => {
      const explainQuery = buildMysqlExplainQuery("SELECT 1 AS SAMPLE_VALUE");
      const rows = await readRows(connection, explainQuery);
      const explainText = JSON.stringify(rows[0]);

      expect(isMysqlExplainJson(explainText)).toBe(true);

      const plan = parseMysqlExplainJson(explainText);
      expect(plan.root.nodeType.length).toBeGreaterThan(0);
      expect(plan.format).toMatch(/^json-v[12]$/);
    });

    it("renders explain plan as text", async () => {
      const explainQuery = buildMysqlExplainQuery("SELECT 1 AS SAMPLE_VALUE");
      const rows = await readRows(connection, explainQuery);
      const explainText = JSON.stringify(rows[0]);

      const plan = parseMysqlExplainJson(explainText);
      const rendered = renderMysqlExplainPlan(plan);

      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered).toContain("cost=");
      expect(rendered).toContain("rows=");
    });

    it("recognizes JSON explain format", async () => {
      const jsonExplain = '{"query_block": {"select_id": 1}}';
      expect(isMysqlExplainJson(jsonExplain)).toBe(true);
    });

    it("rejects non-JSON text", async () => {
      expect(isMysqlExplainJson("not json")).toBe(false);
      expect(isMysqlExplainJson("")).toBe(false);
    });

    it("parses tree format EXPLAIN ANALYZE", () => {
      const treeExplain = `-> Table scan on test_table (cost=10.00 rows=100)
   -> Filter: id > 0 (cost=5.00 rows=50)`;
      const plan = parseMysqlExplainText(treeExplain);
      expect(plan.format).toBe("tree");
      expect(plan.root.nodeType.length).toBeGreaterThan(0);
    });
  });

  describe("tuning advisor", () => {
    it("analyzes a query and returns recommendations", () => {
      const advisor = new MysqlTuningAdvisor();
      const explainJson = JSON.stringify({
        query_block: {
          select_id: 1,
          table: {
            table_name: "test_table",
            access_type: "ALL",
            rows_examined_per_scan: 100000,
            rows_produced_per_join: 100000,
            cost_info: { query_cost: 50000 },
          },
        },
      });

      const report = advisor.analyze({
        sql: "SELECT * FROM test_table",
        explainPlanText: explainJson,
      });

      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.summary.length).toBeGreaterThan(0);
    });

    it("flags SELECT * queries", () => {
      const advisor = new MysqlTuningAdvisor();
      const report = advisor.analyze({
        sql: "SELECT * FROM small_table",
      });

      const selectStarRec = report.recommendations.find(
        (r) => r.id === "MYTA-001",
      );
      expect(selectStarRec).toBeDefined();
      expect(selectStarRec!.severity).toBe("warning");
    });

    it("flags large full scans", () => {
      const advisor = new MysqlTuningAdvisor();
      const explainJson = JSON.stringify({
        query_block: {
          select_id: 1,
          table: {
            table_name: "large_table",
            access_type: "ALL",
            rows_examined_per_scan: 500000,
            rows_produced_per_join: 500000,
            cost_info: { query_cost: 200000 },
          },
        },
      });

      const report = advisor.analyze({
        sql: "SELECT id FROM large_table",
        explainPlanText: explainJson,
      });

      const fullScanRec = report.recommendations.find(
        (r) => r.id === "MYTA-002",
      );
      expect(fullScanRec).toBeDefined();
    });

    it("flags filesort operations", () => {
      const advisor = new MysqlTuningAdvisor();
      const explainJson = JSON.stringify({
        query_block: {
          select_id: 1,
          ordering_operation: {
            using_filesort: true,
            table: {
              table_name: "sorted_table",
              access_type: "ALL",
              rows_examined_per_scan: 1000,
              cost_info: { query_cost: 500 },
            },
          },
        },
      });

      const report = advisor.analyze({
        sql: "SELECT * FROM sorted_table ORDER BY name",
        explainPlanText: explainJson,
      });

      const filesortRec = report.recommendations.find(
        (r) => r.id === "MYTA-004",
      );
      expect(filesortRec).toBeDefined();
    });
  });

  describe("session monitor provider", () => {
    it("lists active sessions", async () => {
      const provider = mysqlDialect.advancedFeatures?.sessionMonitor;
      expect(provider).toBeDefined();

      const mockContext = {} as unknown as import("vscode").ExtensionContext;
      const mockManager = {
        getActiveConnectionName: () => "test-mysql-conn",
        getConnection: async () => ({
          ...config!,
          dbType: "mysql",
        }),
      } as unknown as import("../../core/connectionManager").ConnectionManager;

      const sessions = await provider!.getSessions(
        mockContext,
        mockManager,
        config!.database,
      );

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0]).toHaveProperty("ID");
      expect(sessions[0]).toHaveProperty("USERNAME");
      expect(sessions[0]).toHaveProperty("DBNAME");
    });

    it("lists running queries", async () => {
      const provider = mysqlDialect.advancedFeatures?.sessionMonitor;
      expect(provider).toBeDefined();

      const mockContext = {} as unknown as import("vscode").ExtensionContext;
      const mockManager = {
        getActiveConnectionName: () => "test-mysql-conn",
        getConnection: async () => ({
          ...config!,
          dbType: "mysql",
        }),
      } as unknown as import("../../core/connectionManager").ConnectionManager;

      const queries = await provider!.getQueries(
        mockContext,
        mockManager,
        config!.database,
      );

      expect(Array.isArray(queries)).toBe(true);
    });

    it("returns storage information", async () => {
      const provider = mysqlDialect.advancedFeatures?.sessionMonitor;
      expect(provider).toBeDefined();

      const mockContext = {} as unknown as import("vscode").ExtensionContext;
      const mockManager = {
        getActiveConnectionName: () => "test-mysql-conn",
        getConnection: async () => ({
          ...config!,
          dbType: "mysql",
        }),
      } as unknown as import("../../core/connectionManager").ConnectionManager;

      const storage = await provider!.getStorage(mockContext, mockManager);

      expect(Array.isArray(storage)).toBe(true);
      expect(storage.length).toBeGreaterThanOrEqual(0);
      if (storage.length > 0) {
        expect(storage[0]).toHaveProperty("DATABASE");
        expect(storage[0]).toHaveProperty("USED_MB");
      }
    });
  });

  describe("table maintenance provider", () => {
    it("exposes maintenance methods", () => {
      const provider = mysqlDialect.advancedFeatures?.maintenance;
      expect(provider).toBeDefined();
      expect(typeof provider!.generateStatistics).toBe("function");
      expect(typeof provider!.vacuumTable).toBe("function");
      expect(typeof provider!.analyzeTable).toBe("function");
      expect(typeof provider!.recreateTable).toBe("function");
    });
  });

  describe("import type mapper", () => {
    it("exposes createDataType method", () => {
      const mapper = mysqlDialect.advancedFeatures?.importTypeMapper;
      expect(mapper).toBeDefined();
      expect(typeof mapper!.createDataType).toBe("function");
      expect(typeof mapper!.createColumnTypeChooser).toBe("function");
    });

    it("creates MySQL data types", () => {
      const mapper = mysqlDialect.advancedFeatures!.importTypeMapper!;

      const intType = mapper.createDataType("INTEGER");
      expect(intType.toString()).toBe("BIGINT");

      const varcharType = mapper.createDataType(
        "VARCHAR",
        undefined,
        undefined,
        255,
      );
      expect(varcharType.toString()).toBe("VARCHAR(255)");

      const decimalType = mapper.createDataType("DECIMAL", 10, 2);
      expect(decimalType.toString()).toBe("DECIMAL(10,2)");
    });

    it("handles edge cases", () => {
      const mapper = mysqlDialect.advancedFeatures!.importTypeMapper!;

      const textType = mapper.createDataType("TEXT");
      expect(textType.toString()).toBe("LONGTEXT");

      const jsonType = mapper.createDataType("JSON");
      expect(jsonType.toString()).toBe("JSON");
    });
  });

  describe("copilot reference provider", () => {
    it("exposes getReference method", () => {
      const provider = mysqlDialect.advancedFeatures?.copilotReferenceProvider;
      expect(provider).toBeDefined();
      expect(typeof provider!.getReference).toBe("function");
    });

    it("returns reference content", () => {
      const provider = mysqlDialect.advancedFeatures!.copilotReferenceProvider!;
      const reference = provider.getReference("optimization");
      expect(typeof reference).toBe("string");
      expect(reference.length).toBeGreaterThan(0);
    });
  });
});

if (!config) {
  console.log(
    "⚠️ MySQL integration test skipped: set RUN_MYSQL_INTEGRATION=1 (or MYSQL_LIVE_TEST_ENABLED=1) with MYSQL_LIVE_TEST_* env vars for an explicit live-server run.",
  );
}
