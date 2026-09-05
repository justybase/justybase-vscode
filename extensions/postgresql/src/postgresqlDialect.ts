import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities, getDatabaseDesignerCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { PostgreSqlConnection } from "./postgresqlConnection";
import { postgresqlAdvancedFeatures } from "./postgresqlDdlGenerator";
import { postgresqlMetadataProvider } from "./postgresqlSchemaProvider";
import { postgresqlCompatibleDialectTraits as postgresqlDialectTraits } from "../../../src/shared/dialect-traits/postgresql-compatible";
import { postgresqlSqlAuthoring } from "./postgresqlSqlAuthoring";

const postgresqlConnectionConstructor =
  PostgreSqlConnection as unknown as DatabaseConnectionStaticConstructor;

export const postgresqlDialect: DatabaseDialect = {
  kind: "postgresql",
  displayName: "PostgreSQL",
  defaultPort: 5432,
  supportsRawTcpTunnel: true,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
  }),
  designerCapabilities: getDatabaseDesignerCapabilities("postgresql"),
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 5432,
        userPlaceholder: "PostgreSQL user",
      }),
      {
        key: "searchPath",
        label: "Search Path",
        type: "text",
        storage: "options",
        placeholder: "Optional, for example public, app",
        description:
          "Optional PostgreSQL search_path applied after connection.",
        layout: "full",
      },
      {
        key: "sslMode",
        label: "SSL Mode",
        type: "select",
        storage: "options",
        defaultValue: "",
        options: [
          {
            value: "",
            label: "Default",
          },
          {
            value: "require",
            label: "Require (skip certificate validation)",
          },
          {
            value: "verify-full",
            label: "Verify certificate",
          },
        ],
        description: "Simple SSL options for pg.",
        layout: "half",
      },
      {
        key: "sslServerName",
        label: "TLS Server Name",
        type: "text",
        storage: "options",
        placeholder: "Optional certificate DNS name",
        description:
          "Optional TLS server name. Useful when PostgreSQL is reached through a local tunnel; use 127.0.0.1 as Host with verify-full.",
        layout: "full",
      },
      {
        key: "connectTimeout",
        label: "Connect Timeout (s)",
        type: "number",
        storage: "options",
        min: 1,
        max: 300,
        description: "Optional connection timeout passed to pg.",
        layout: "half",
      },
      {
        key: "statementTimeout",
        label: "Session Statement Timeout (s)",
        type: "number",
        storage: "options",
        min: 1,
        max: 86400,
        description: "Optional statement_timeout applied after connecting.",
        layout: "half",
      },
    ],
  },
  traits: postgresqlDialectTraits,
  metadataProvider: postgresqlMetadataProvider,
  sqlAuthoring: postgresqlSqlAuthoring,
  advancedFeatures: postgresqlAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return postgresqlConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new PostgreSqlConnection(config);
  },
};
