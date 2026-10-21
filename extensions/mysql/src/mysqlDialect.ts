import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities, getDatabaseDesignerCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "@justybase/database-utils/connectionFormBuilder";
import { MysqlConnection } from "./mysqlConnection";
import { mysqlAdvancedFeatures } from "./mysqlDdlGenerator";
import { mysqlMetadataProvider } from "./mysqlSchemaProvider";
import { mysqlSqlAuthoring } from "./mysqlSqlAuthoring";
import { mysqlDialectTraits } from "@justybase/dialect-utils/traits/mysql";

const mysqlConnectionConstructor =
  MysqlConnection as unknown as DatabaseConnectionStaticConstructor;

export const mysqlDialect: DatabaseDialect = {
  kind: "mysql",
  displayName: "MySQL",
  defaultPort: 3306,
  supportsRawTcpTunnel: true,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
    supportsVacuumTable: true,
    supportsAnalyzeTable: true,
    supportsTruncateTable: true,
    supportsTableComments: true,
    supportsColumnComments: false, // MySQL needs the full column definition (MODIFY COLUMN)
    supportsGrants: true,
    supportsTableRename: true,
    supportsTableOwnerChange: false, // MySQL tables have no owner
    supportsPrimaryKeyChanges: true,
    supportsForeignKeyChanges: true,
    supportsErDiagram: true,
    supportsTableSizeReport: true,
    supportsTablePrivilegesReport: true,
    supportsTableMaintenanceReport: true,
    supportsLockReport: true,
    tableReclaimStyle: 'optimize',
    supportsUniqueConstraintChanges: true,
  }),
  designerCapabilities: getDatabaseDesignerCapabilities("mysql"),
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
