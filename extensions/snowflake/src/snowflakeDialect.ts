import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseDialect,
} from "@justybase/contracts";
import { createDatabaseCapabilities } from "@justybase/contracts";
import { createStandardConnectionFields } from "../../../src/core/connectionFormBuilder";
import { snowflakeDialectTraits } from "../../../src/shared/dialect-traits/snowflake";
import { SnowflakeConnection } from "./snowflakeConnection";
import { snowflakeAdvancedFeatures } from "./snowflakeDdlGenerator";
import { snowflakeMetadataProvider } from "./snowflakeSchemaProvider";
import { snowflakeSqlAuthoring } from "./snowflakeSqlAuthoring";

const snowflakeConnectionConstructor =
  SnowflakeConnection as unknown as DatabaseConnectionStaticConstructor;

export const snowflakeDialect: DatabaseDialect = {
  kind: "snowflake",
  displayName: "Snowflake",
  defaultPort: 443,
  capabilities: createDatabaseCapabilities({
    supportsExplainPlan: true,
    supportsExplainGraph: true,
    supportsTuningAdvisor: true,
    supportsProcedures: true,
  }),
  connectionForm: {
    fields: [
      ...createStandardConnectionFields({
        defaultPort: 443,
        hostPlaceholder: "Account locator or full host",
        userPlaceholder: "Snowflake user",
      }),
      {
        key: "schema",
        label: "Schema",
        type: "text",
        storage: "options",
        placeholder: "Optional default schema",
        description: "Optional schema selected after connecting.",
        layout: "half",
      },
      {
        key: "authMode",
        label: "Authentication",
        type: "select",
        storage: "options",
        defaultValue: "SNOWFLAKE",
        options: [
          { value: "SNOWFLAKE", label: "Username / Password" },
          { value: "OAUTH", label: "OAuth Token" },
          { value: "SNOWFLAKE_JWT", label: "Key Pair (JWT)" },
          { value: "EXTERNALBROWSER", label: "External Browser SSO" },
        ],
        description: "Preferred Snowflake authentication mode.",
        layout: "half",
      },
      {
        key: "warehouse",
        label: "Warehouse",
        type: "text",
        storage: "options",
        placeholder: "Optional warehouse",
        description: "Optional warehouse used for the session.",
        layout: "half",
      },
      {
        key: "role",
        label: "Role",
        type: "text",
        storage: "options",
        placeholder: "Optional role",
        description: "Optional role applied by the Snowflake driver.",
        layout: "half",
      },
      {
        key: "oauthToken",
        label: "OAuth Token",
        type: "password",
        storage: "options",
        placeholder: "Optional token or env:VAR_NAME",
        description:
          "Used when Authentication is OAuth. Supports env:VAR_NAME resolution.",
        layout: "full",
      },
      {
        key: "privateKeyPath",
        label: "Private Key Path",
        type: "text",
        storage: "options",
        placeholder: "Optional .p8 path or env:VAR_NAME",
        description:
          "Used for key-pair authentication. Supports env:VAR_NAME resolution.",
        layout: "full",
      },
      {
        key: "privateKeyPassphrase",
        label: "Private Key Passphrase",
        type: "password",
        storage: "options",
        placeholder: "Optional passphrase or env:VAR_NAME",
        description: "Optional passphrase for encrypted key files.",
        layout: "half",
      },
      {
        key: "authenticator",
        label: "Authenticator",
        type: "text",
        storage: "options",
        placeholder: "Optional authenticator value",
        description:
          "Optional authenticator, for example externalbrowser or Okta URL.",
        layout: "half",
      },
      {
        key: "account",
        label: "Account Override",
        type: "text",
        storage: "options",
        placeholder: "Optional account identifier override",
        description: "When set, overrides the account value derived from Host.",
        layout: "full",
      },
      {
        key: "accessUrl",
        label: "Access URL",
        type: "text",
        storage: "options",
        placeholder:
          "Optional https://<account>.<region>.snowflakecomputing.com",
        description: "Optional fully-qualified endpoint override.",
        layout: "full",
      },
      {
        key: "sessionParameters",
        label: "Session Parameters",
        type: "text",
        storage: "options",
        placeholder: "Optional KEY=VALUE;QUERY_TAG=justybase",
        description: "Optional ALTER SESSION parameters applied after connect.",
        layout: "full",
      },
    ],
  },
  traits: snowflakeDialectTraits,
  metadataProvider: snowflakeMetadataProvider,
  sqlAuthoring: snowflakeSqlAuthoring,
  advancedFeatures: snowflakeAdvancedFeatures,
  getConnectionConstructor(): DatabaseConnectionStaticConstructor {
    return snowflakeConnectionConstructor;
  },
  createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
    return new SnowflakeConnection(config);
  },
};
