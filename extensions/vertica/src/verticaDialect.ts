import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { verticaDialectTraits } from "../../../src/shared/dialect-traits/vertica";
import { VerticaConnection } from "./verticaConnection";
import { verticaAdvancedFeatures } from "./verticaDdlGenerator";
import { verticaMetadataProvider } from "./verticaSchemaProvider";
import { verticaSqlAuthoring } from "./verticaSqlAuthoring";

const verticaConnectionConstructor =
  VerticaConnection as unknown as DatabaseConnectionStaticConstructor;

export const verticaDialect: DatabaseDialect = {
  kind: "vertica",
  displayName: "Vertica",
  defaultPort: 5433,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsExternalTables: true,
    supportsProcedures: true,
    supportsTableMaintenance: true,
    supportsSessionMonitor: true,
  }),
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 5433,
        userPlaceholder: "Vertica user",
      }),
      {
        key: "searchPath",
        label: "Search Path",
        type: "text",
        storage: "options",
        placeholder: "Optional, for example public, analytics",
        description: "Optional Vertica search path applied after connecting.",
        layout: "full",
      },
      {
        key: "tlsMode",
        label: "TLS Mode",
        type: "select",
        storage: "options",
        defaultValue: "prefer",
        options: [
          { value: "disable", label: "Disable" },
          { value: "prefer", label: "Prefer" },
          { value: "require", label: "Require" },
          { value: "verify-ca", label: "Verify CA" },
          { value: "verify-full", label: "Verify Full" },
        ],
        description: "TLS mode passed to vertica-nodejs.",
        layout: "half",
      },
      {
        key: "trustedCertsPath",
        label: "Trusted CA PEM",
        type: "text",
        storage: "options",
        placeholder: "Optional path to trusted CA bundle",
        description: "Optional PEM bundle for TLS verification.",
        layout: "full",
      },
      {
        key: "clientLabel",
        label: "Client Label",
        type: "text",
        storage: "options",
        placeholder: "Optional session label",
        description: "Optional client label shown in V_MONITOR.SESSIONS.",
        layout: "half",
      },
      {
        key: "workload",
        label: "Workload",
        type: "text",
        storage: "options",
        placeholder: "Optional workload routing label",
        description: "Optional workload name passed to vertica-nodejs.",
        layout: "half",
      },
    ],
  },
  traits: verticaDialectTraits,
  metadataProvider: verticaMetadataProvider,
  sqlAuthoring: verticaSqlAuthoring,
  advancedFeatures: verticaAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return verticaConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new VerticaConnection(config);
  },
};
