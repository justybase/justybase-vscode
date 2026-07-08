import { createDatabaseDialectTraits } from "../../contracts/database";

export const verticaDialectTraits = createDatabaseDialectTraits({
  identifiers: {
    unquotedIdentifierPattern: /^[a-z_][a-z0-9_$]*$/,
    generatedNameCase: "lower",
  },
  qualification: {
    supportsThreePartName: false,
    twoPartNameStyle: "schema-object",
    twoPartContainerPreference: "schema-over-database",
    databaseOnlyReferenceStyle: "omit",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
