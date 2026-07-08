import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { MysqlConnection } from "./mysqlConnection";
import { mysqlAdvancedFeatures } from "./mysqlDdlGenerator";
import { mysqlMetadataProvider } from "./mysqlSchemaProvider";
import { mysqlSqlAuthoring } from "./mysqlSqlAuthoring";
import { mysqlDialectTraits } from "../../../src/shared/dialect-traits/mysql";

const mysqlConnectionConstructor =
  MysqlConnection as unknown as DatabaseConnectionStaticConstructor;

export const mysqlDialect: DatabaseDialect = {
  kind: "mysql",
  displayName: "MySQL",
  defaultPort: 3306,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
  }),
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 3306,
        userPlaceholder: "MySQL user",
      }),
      {
        key: "connectTimeout",
        label: "Connect Timeout (ms)",
        type: "number",
        storage: "options",
        min: 1000,
        max: 300000,
        description: "Optional connection timeout passed to mysql2.",
        layout: "half",
      },
    ],
  },
  traits: mysqlDialectTraits,
  metadataProvider: mysqlMetadataProvider,
  sqlAuthoring: mysqlSqlAuthoring,
  advancedFeatures: mysqlAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return mysqlConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new MysqlConnection(config);
  },
};
