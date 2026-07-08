import type {
  DatabaseCapabilities,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { Db2Connection } from "./db2Connection";
import { db2AdvancedFeatures } from "./db2DdlGenerator";
import { db2MetadataProvider } from "./db2SchemaProvider";
import { db2SqlAuthoring } from "./db2SqlAuthoring";
import { db2DialectTraits } from "../../../src/shared/dialect-traits/db2";

const db2ConnectionConstructor =
  Db2Connection as unknown as DatabaseConnectionStaticConstructor;

const db2Capabilities: DatabaseCapabilities = {
  supportsExplainPlan: true,
  supportsExplainGraph: true,
  supportsTuningAdvisor: true,
  supportsExternalTables: false,
  supportsProcedures: true,
  supportsTableMaintenance: true,
  supportsSessionMonitor: true,
};

export const db2Dialect: DatabaseDialect = {
  kind: "db2",
  displayName: "Db2 LUW",
  defaultPort: 50000,
  capabilities: db2Capabilities,
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 50000,
        databasePlaceholder: "Db2 database name",
        userPlaceholder: "Db2 user",
      }),
      {
        key: "currentSchema",
        label: "Current Schema",
        type: "text",
        storage: "options",
        placeholder: "Optional CURRENTSCHEMA override",
        description:
          "Sets CURRENTSCHEMA in the Db2 connection string when provided.",
        layout: "half",
      },
      {
        key: "connectTimeout",
        label: "Connect Timeout (s)",
        type: "number",
        storage: "options",
        min: 1,
        max: 300,
        description: "Optional connection timeout passed to ibm_db.",
        layout: "half",
      },
      {
        key: "clientCodepage",
        label: "Client Codepage",
        type: "text",
        storage: "options",
        placeholder: "Optional, for example 1208",
        description:
          "Optional Db2 ClientCodepage override. Leave blank to use the driver default conversion.",
        layout: "half",
      },
      {
        key: "security",
        label: "Security",
        type: "select",
        storage: "options",
        defaultValue: "",
        options: [
          {
            value: "",
            label: "Default",
          },
          {
            value: "SSL",
            label: "SSL",
          },
        ],
        description: "Set Security=SSL for secure Db2 connections.",
        layout: "half",
      },
      {
        key: "sslServerCertificate",
        label: "SSL Server Certificate",
        type: "text",
        storage: "options",
        placeholder: "Optional certificate path for Security=SSL",
        layout: "half",
      },
    ],
  },
  traits: db2DialectTraits,
  metadataProvider: db2MetadataProvider,
  sqlAuthoring: db2SqlAuthoring,
  advancedFeatures: db2AdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return db2ConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new Db2Connection(config);
  },
};
