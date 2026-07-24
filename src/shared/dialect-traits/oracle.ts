import { createDatabaseDialectTraits } from "../../contracts/database";

export const oracleDialectTraits = createDatabaseDialectTraits({
  identifiers: {
    // Oracle stores unquoted identifiers as uppercase
    generatedNameCase: 'upper',
    // Oracle unquoted identifiers can contain $ and # in addition to letters/numbers/underscore
    unquotedIdentifierPattern: /^[A-Z_$#][A-Z0-9_$#]*$/,
  },
  qualification: {
    // Oracle uses SCHEMA.OBJECT (no database/catalog level in the same sense)
    twoPartContainerPreference: 'schema-over-database',
    // Oracle doesn't support CATALOG.SCHEMA.TABLE without database links
    supportsThreePartName: false,
    // Oracle doesn't use DB..TABLE notation
    databaseOnlyReferenceStyle: 'omit',
  },
  completion: {
    singleDotPathNamespace: 'schema',
    // Oracle doesn't support DB..TABLE (double-dot path)
    supportsDoubleDotPath: false,
  },
});
