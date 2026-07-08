import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { MsSqlConnection } from "./mssqlConnection";
import { mssqlAdvancedFeatures } from "./mssqlDdlGenerator";
import { mssqlMetadataProvider } from "./mssqlSchemaProvider";
import { mssqlSqlAuthoring } from "./mssqlSqlAuthoring";
import { mssqlDialectTraits } from "../../../src/shared/dialect-traits/mssql";

const mssqlConnectionConstructor =
  MsSqlConnection as unknown as DatabaseConnectionStaticConstructor;

export const mssqlDialect: DatabaseDialect = {
  kind: "mssql",
  displayName: "MS SQL Server",
  defaultPort: 1433,
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
        defaultPort: 1433,
        userPlaceholder: "MS SQL Server user",
      }),
      {
        key: "domain",
        label: "Domain",
        type: "text",
        storage: "options",
        placeholder: "Domain name (for Windows Auth)",
        description: "Optional domain for Windows Authentication.",
        layout: "half",
      },
      {
        key: "encrypt",
        label: "Encrypt",
        type: "select",
        storage: "options",
        defaultValue: "true",
        options: [
          {
            value: "true",
            label: "True",
          },
          {
            value: "false",
            label: "False",
          },
        ],
        description: "Use encryption (required for Azure).",
        layout: "half",
      },
      {
        key: "trustServerCertificate",
        label: "Trust Server Certificate",
        type: "select",
        storage: "options",
        defaultValue: "true",
        options: [
          {
            value: "true",
            label: "True",
          },
          {
            value: "false",
            label: "False",
          },
        ],
        description: "Trust self-signed certificates.",
        layout: "half",
      },
      {
        key: "connectTimeout",
        label: "Connect Timeout (ms)",
        type: "number",
        storage: "options",
        min: 1000,
        max: 300000,
        defaultValue: 15000,
        description: "Optional connection timeout.",
        layout: "half",
      },
      {
        key: "requestTimeout",
        label: "Request Timeout (ms)",
        type: "number",
        storage: "options",
        min: 1000,
        max: 300000,
        defaultValue: 15000,
        description: "Optional request timeout.",
        layout: "half",
      },
    ],
  },
  traits: mssqlDialectTraits,
  metadataProvider: mssqlMetadataProvider,
  sqlAuthoring: mssqlSqlAuthoring,
  advancedFeatures: mssqlAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return mssqlConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new MsSqlConnection(config);
  },
};
