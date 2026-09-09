import { createDatabaseDialectTraits } from "@justybase/contracts";

export const db2DialectTraits = createDatabaseDialectTraits({
  qualification: {
    threePartNamePrefix: "location",
  },
  completion: {
    singleDotPathNamespace: "schema",
  },
});
