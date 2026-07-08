import { createDatabaseDialectTraits } from "../../contracts/database";

export const db2DialectTraits = createDatabaseDialectTraits({
  completion: {
    singleDotPathNamespace: "schema",
  },
});
