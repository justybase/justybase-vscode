import { createDatabaseDialectTraits } from "../../contracts/database";

export const mssqlDialectTraits = createDatabaseDialectTraits({
  completion: {
    singleDotPathNamespace: "schema-or-database",
    supportsDoubleDotPath: true,
  },
});
