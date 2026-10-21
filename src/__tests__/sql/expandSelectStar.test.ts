jest.unmock("chevrotain");

import {
  applyTextReplacements,
  buildSelectStarExpansion,
  findSelectStarContext,
  type ExpandStarLayout,
  type SelectStarSource,
} from "../../sql/expandSelectStar";

const DIMDATE_COLUMNS = [
  "DATEKEY", "FULLDATEALTERNATEKEY", "DAYNUMBEROFWEEK", "ENGLISHDAYNAMEOFWEEK",
  "SPANISHDAYNAMEOFWEEK", "FRENCHDAYNAMEOFWEEK", "DAYNUMBEROFMONTH", "DAYNUMBEROFYEAR",
  "WEEKNUMBEROFYEAR", "ENGLISHMONTHNAME", "SPANISHMONTHNAME", "FRENCHMONTHNAME",
  "MONTHNUMBEROFYEAR", "CALENDARQUARTER", "CALENDARYEAR", "CALENDARSEMESTER",
  "FISCALQUARTER", "FISCALYEAR", "FISCALSEMESTER",
];

const CATALOG: Record<string, string[]> = {
  DIMDATE: DIMDATE_COLUMNS,
  DIMACCOUNT: ["ACCOUNTKEY", "ACCOUNTNAME"],
  ORDERS: ["ID", "CUSTOMER_ID"],
  CUSTOMERS: ["ID", "NAME"],
  WEIRD: ["Mixed Case"],
};

function expand(
  sqlWithStarMarker: string,
  layout?: ExpandStarLayout,
  getColumns: (source: SelectStarSource) => readonly string[] | undefined = (source) => CATALOG[source.table.toUpperCase()],
): string | undefined {
  // `^` marks the `*` (or the `X.*` star) to expand.
  const starOffset = sqlWithStarMarker.indexOf("^");
  const sql = sqlWithStarMarker.replace("^", "");
  const context = findSelectStarContext(sql, starOffset);
  if (!context) return undefined;
  const edits = buildSelectStarExpansion(sql, context, { layout, databaseKind: "netezza", getColumns });
  return edits ? applyTextReplacements(sql, edits) : undefined;
}

describe("expandSelectStar", () => {
  it("expands SELECT * FROM DIMDATE with a generated alias and leading commas", () => {
    expect(expand("SELECT ^* FROM DIMDATE")).toBe([
      "SELECT ",
      "    D.DATEKEY",
      ...DIMDATE_COLUMNS.slice(1).map((column) => `    , D.${column}`),
      " FROM DIMDATE D",
    ].join("\n"));
  });

  it("reuses an existing alias, with or without AS", () => {
    expect(expand("SELECT ^* FROM JUST_DATA..DIMACCOUNT A")).toBe(
      "SELECT \n    A.ACCOUNTKEY\n    , A.ACCOUNTNAME\n FROM JUST_DATA..DIMACCOUNT A",
    );
    expect(expand("SELECT ^* FROM JUST_DATA.ADMIN.DIMACCOUNT AS X WHERE X.ACCOUNTKEY > 0")).toBe(
      "SELECT \n    X.ACCOUNTKEY\n    , X.ACCOUNTNAME\n FROM JUST_DATA.ADMIN.DIMACCOUNT AS X WHERE X.ACCOUNTKEY > 0",
    );
  });

  it("supports trailing-comma and single-line layouts", () => {
    expect(expand("SELECT ^* FROM DIMACCOUNT", "trailingComma")).toBe(
      "SELECT \n    D.ACCOUNTKEY,\n    D.ACCOUNTNAME\n FROM DIMACCOUNT D",
    );
    expect(expand("SELECT ^* FROM DIMACCOUNT", "singleLine")).toBe(
      "SELECT D.ACCOUNTKEY, D.ACCOUNTNAME FROM DIMACCOUNT D",
    );
  });

  it("expands every joined source and aliases only the unaliased ones uniquely", () => {
    expect(expand("SELECT ^* FROM CUSTOMERS C JOIN ORDERS ON C.ID = 1", "singleLine")).toBe(
      "SELECT C.ID, C.NAME, O.ID, O.CUSTOMER_ID FROM CUSTOMERS C JOIN ORDERS O ON C.ID = 1",
    );
    expect(expand("SELECT ^* FROM DIMDATE, DIMACCOUNT", "singleLine")).toBe(
      `SELECT ${DIMDATE_COLUMNS.map((c) => `D.${c}`).join(", ")}, D2.ACCOUNTKEY, D2.ACCOUNTNAME FROM DIMDATE D, DIMACCOUNT D2`,
    );
  });

  it("expands only the qualified source for X.*", () => {
    expect(expand("SELECT C.NAME, O.^* FROM CUSTOMERS C JOIN ORDERS O ON C.ID = O.CUSTOMER_ID", "singleLine")).toBe(
      "SELECT C.NAME, O.ID, O.CUSTOMER_ID FROM CUSTOMERS C JOIN ORDERS O ON C.ID = O.CUSTOMER_ID",
    );
  });

  it("keeps the table name as qualifier when the statement already references it", () => {
    expect(expand("SELECT ^* FROM DIMACCOUNT WHERE DIMACCOUNT.ACCOUNTKEY > 0", "singleLine")).toBe(
      "SELECT DIMACCOUNT.ACCOUNTKEY, DIMACCOUNT.ACCOUNTNAME FROM DIMACCOUNT WHERE DIMACCOUNT.ACCOUNTKEY > 0",
    );
  });

  it("keeps the indentation of a star on its own line and of nested queries", () => {
    expect(expand("SELECT\n    ^*\nFROM DIMACCOUNT")).toBe(
      "SELECT\n    D.ACCOUNTKEY\n    , D.ACCOUNTNAME\nFROM DIMACCOUNT D",
    );
    expect(expand("WITH X AS (\n  SELECT ^* FROM DIMACCOUNT\n)\nSELECT 1 FROM X")).toBe(
      "WITH X AS (\n  SELECT \n      D.ACCOUNTKEY\n      , D.ACCOUNTNAME\n   FROM DIMACCOUNT D\n)\nSELECT 1 FROM X",
    );
  });

  it("quotes identifiers that need quoting", () => {
    expect(expand("SELECT ^* FROM WEIRD", "singleLine")).toBe('SELECT W."Mixed Case" FROM WEIRD W');
  });

  it("offers nothing when columns are unknown or the star is not a select item", () => {
    expect(expand("SELECT ^* FROM UNKNOWN_TABLE")).toBeUndefined();
    expect(expand("SELECT 2 ^* 3 FROM DIMACCOUNT")).toBeUndefined();
    expect(expand("SELECT COUNT(^*) FROM DIMACCOUNT")).toBeUndefined();
  });
});
