import { createDatabaseDialectTraits } from "../../contracts/database";

export const mysqlDialectTraits = createDatabaseDialectTraits({
  identifiers: {
    quoteStyle: "backtick",
    unquotedIdentifierPattern: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  },
  qualification: {
    twoPartNameStyle: "database-object",
    twoPartContainerPreference: "database-over-schema",
    supportsThreePartName: false,
    databaseOnlyReferenceStyle: "single-dot",
  },
  completion: {
    singleDotPathNamespace: "database",
  },
});
