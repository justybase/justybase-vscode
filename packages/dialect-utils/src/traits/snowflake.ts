import { createDatabaseDialectTraits } from "@justybase/contracts";

export const snowflakeDialectTraits = createDatabaseDialectTraits({
  qualification: {
    databaseOnlyReferenceStyle: "omit",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
