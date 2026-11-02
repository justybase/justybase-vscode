jest.unmock("chevrotain");

import { toRankedMetadataColumnItems } from "../../server/completionRenderer";
import { isNumericAggregateQualifierPosition } from "../../server/completionExpressionAnalyzer";

const columns = [
  { name: "CUSTOMERKEY", type: "INTEGER" },
  { name: "COLOR", type: "CHARACTER VARYING(15)" },
  { name: "ORDERDATE", type: "DATE" },
  { name: "SALESAMOUNT", type: "NUMERIC(19,4)" },
  { name: "NOTE" },
];

const sortTexts = (clause: string) => Object.fromEntries(
  toRankedMetadataColumnItems(columns, undefined, { clause, table: "FACTINTERNETSALES" })
    .map((item) => [item.label, item.sortText]),
);

describe("column clause prior", () => {
  it("puts non-key numeric columns first in a SUM(/AVG( argument", () => {
    expect(sortTexts("aggregate")).toEqual({
      CUSTOMERKEY: "3_1_CUSTOMERKEY",
      COLOR: "3_1_COLOR",
      ORDERDATE: "3_1_ORDERDATE",
      SALESAMOUNT: "3_0_SALESAMOUNT",
      // Unknown type: only keys move last, as in SELECT.
      NOTE: "3_0_NOTE",
    });
  });

  it("recognises the argument of SUM and AVG only", () => {
    expect(isNumericAggregateQualifierPosition("SELECT SUM(f.")).toBe(true);
    expect(isNumericAggregateQualifierPosition("SELECT AVG(DISTINCT f.SAL")).toBe(true);
    expect(isNumericAggregateQualifierPosition("SELECT SUM(ADMIN.F.")).toBe(true);
    expect(isNumericAggregateQualifierPosition("SELECT MAX(f.")).toBe(false);
    expect(isNumericAggregateQualifierPosition("SELECT SUM(f.A * f.")).toBe(false);
    expect(isNumericAggregateQualifierPosition("SELECT f.")).toBe(false);
  });
});
