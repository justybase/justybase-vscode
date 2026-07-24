import {
  createDatabaseCapabilities,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { OracleConnection } from "./oracleConnection";
import { oracleAdvancedFeatures } from "./oracleDdlGenerator";
import { oracleMetadataProvider } from "./oracleSchemaProvider";
import { oracleSqlAuthoring } from "./oracleSqlAuthoring";
import { oracleDialectTraits } from "../../../src/shared/dialect-traits/oracle";

const oracleConnectionConstructor =
  OracleConnection as unknown as DatabaseConnectionStaticConstructor;

export const oracleDialect: DatabaseDialect = {
  kind: "oracle",
  displayName: "Oracle",
  defaultPort: 1521,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
    supportsDistributionMetrics: false,
  }),
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 1521,
        databaseLabel: "Service Name",
        databasePlaceholder: "Oracle service name or PDB service",
        databaseDescription:
          "Used with Host and Port to build a thin-mode Easy Connect string when Connect String Override is blank.",
        userPlaceholder: "Oracle user",
      }),
      {
        key: "currentSchema",
        label: "Current Schema",
        type: "text",
        storage: "options",
        placeholder: "Optional default schema",
        description:
          "When provided, the Oracle connection sets currentSchema after connect.",
        layout: "half",
      },
      {
        key: "connectTimeout",
        label: "Connect Timeout (s)",
        type: "number",
        storage: "options",
        min: 1,
        max: 300,
        description: "Optional connection timeout passed to node-oracledb.",
        layout: "half",
      },
      {
        key: "connectString",
        label: "Connect String Override",
        type: "text",
        storage: "options",
        placeholder: "Optional Easy Connect Plus string or TNS alias",
        description:
          "Overrides Host/Port/Service and is useful for advanced descriptors, SID-style aliases, or TNS names.",
        layout: "full",
      },
      {
        key: "configDir",
        label: "Oracle Net Config Dir",
        type: "text",
        storage: "options",
        placeholder: "Optional tnsnames.ora / wallet directory",
        description:
          "Optional Oracle Net configuration directory for TNS aliases or thin-mode wallet files.",
        layout: "full",
      },
    ],
  },
  traits: oracleDialectTraits,
  metadataProvider: oracleMetadataProvider,
  sqlAuthoring: oracleSqlAuthoring,
  advancedFeatures: oracleAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return oracleConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new OracleConnection(config);
  },
};
