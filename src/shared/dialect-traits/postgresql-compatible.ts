import { createDatabaseDialectTraits } from "../../contracts/database";

const POSTGRESQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_$]*$/;

export const postgresqlCompatibleDialectTraits = createDatabaseDialectTraits({
  identifiers: {
    unquotedIdentifierPattern: POSTGRESQL_IDENTIFIER_PATTERN,
    generatedNameCase: "lower",
  },
  qualification: {
    supportsThreePartName: false,
    twoPartNameStyle: "schema-object",
    twoPartContainerPreference: "schema-over-database",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
