import { createDatabaseDialectTraits } from "@justybase/contracts";

export const MSSQL_UNQUOTED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const mssqlDialectTraits = createDatabaseDialectTraits({
  identifiers: {
    unquotedIdentifierPattern: MSSQL_UNQUOTED_IDENTIFIER_PATTERN,
    generatedNameCase: "preserve",
  },
  completion: {
    singleDotPathNamespace: "schema-or-database",
    supportsDoubleDotPath: true,
  },
});
