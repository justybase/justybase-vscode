import { createDatabaseDialectTraits } from "../../contracts/database";

export const snowflakeDialectTraits = createDatabaseDialectTraits({
  qualification: {
    databaseOnlyReferenceStyle: "omit",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
