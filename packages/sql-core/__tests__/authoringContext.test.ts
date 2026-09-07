jest.unmock("chevrotain");

import { collectNetezzaAuthoringContext } from "../src/authoringContext";

describe("collectNetezzaAuthoringContext", () => {
  it("collects parser-derived table paths and aliases", () => {
    expect(collectNetezzaAuthoringContext(
      "SELECT O.ID FROM DB.PUBLIC.ORDERS O JOIN DB..DETAIL D ON D.ORDER_ID = O.ID",
    ).tableReferences).toEqual([
      { database: "DB", schema: "PUBLIC", name: "ORDERS", alias: "O" },
      { database: "DB", name: "DETAIL", alias: "D" },
    ]);
  });

  it("does not turn CTEs, comments, or string literals into metadata references", () => {
    const context = collectNetezzaAuthoringContext(
      "WITH C AS (SELECT * FROM DB..ORDERS) SELECT 'FROM FAKE.X', O.ID FROM C O -- JOIN ALSO_FAKE X\n",
    );

    expect(context.tableReferences).toEqual([
      { database: "DB", name: "ORDERS", alias: undefined },
    ]);
    expect(context.qualifiedColumnReferences).toEqual([
      expect.objectContaining({ qualifier: "O", column: "ID" }),
    ]);
  });

  it("preserves quoted identifier spelling for metadata lookup", () => {
    expect(collectNetezzaAuthoringContext(
      'SELECT "o"."Column" FROM "Db"."Reporting"."Orders" "o"',
    )).toEqual(expect.objectContaining({
      tableReferences: [{ database: "Db", schema: "Reporting", name: "Orders", alias: "o" }],
      qualifiedColumnReferences: expect.arrayContaining([
        expect.objectContaining({ qualifier: "o", column: "Column" }),
      ]),
    }));
  });
});
