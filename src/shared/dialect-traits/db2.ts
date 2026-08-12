import { createDatabaseDialectTraits } from "../../contracts/database";

export const db2DialectTraits = createDatabaseDialectTraits({
  qualification: {
    threePartNamePrefix: "location",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
