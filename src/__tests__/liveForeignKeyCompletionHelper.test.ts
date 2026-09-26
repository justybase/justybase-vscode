import {
  expectLiveForeignKeyCompletion,
  expectLiveVirtualJoinCompletion,
} from "./integration/liveForeignKeyCompletionHelper";

describe("catalog FK completion adapter", () => {
  it("uses exact composite mappings for both JOIN targets and an empty ON clause", async () => {
    await expectLiveForeignKeyCompletion({
      databaseKind: "postgresql",
      database: "appdb",
      schema: "public",
      parentTable: "customer",
      childTable: "order_line",
      rows: [
        {
          FROM_DATABASE: "appdb",
          FROM_SCHEMA: "public",
          FROM_TABLE: "order_line",
          FROM_COLUMN: "tenant_id",
          TO_DATABASE: "appdb",
          TO_SCHEMA: "public",
          TO_TABLE: "customer",
          TO_COLUMN: "tenant_key",
          CONSTRAINT_NAME: "fk_order_line_customer",
          ORDINAL_POSITION: 1,
        },
        {
          FROM_DATABASE: "appdb",
          FROM_SCHEMA: "public",
          FROM_TABLE: "order_line",
          FROM_COLUMN: "customer_id",
          TO_DATABASE: "appdb",
          TO_SCHEMA: "public",
          TO_TABLE: "customer",
          TO_COLUMN: "customer_key",
          CONSTRAINT_NAME: "fk_order_line_customer",
          ORDINAL_POSITION: 2,
        },
      ],
    });
  });

  it("uses an explicit virtual composite mapping for Netezza", async () => {
    await expectLiveVirtualJoinCompletion({
      databaseKind: "netezza",
      database: "ANALYTICS",
      schema: "ADMIN",
      leftTable: "CUSTOMER",
      rightTable: "ORDERS",
      columns: [
        { left: "TENANT_KEY", right: "TENANT_ID" },
        { left: "CUSTOMER_KEY", right: "CUSTOMER_ID" },
      ],
    });
  });
});
