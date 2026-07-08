import { createDatabaseDialectTraits } from "../../contracts/database";

export const oracleDialectTraits = createDatabaseDialectTraits({
  completion: {
    singleDotPathNamespace: "schema",
  },
});
