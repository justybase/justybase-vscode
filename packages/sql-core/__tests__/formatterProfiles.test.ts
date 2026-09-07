import { getSqlFormatterProfile } from "../src/formatterProfiles";

describe("sql-core formatter profiles", () => {
  it("selects dialect overlays and falls back safely", () => {
    expect(getSqlFormatterProfile().keywords.has("SELECT")).toBe(true);
    expect(getSqlFormatterProfile("sqlite").keywords.has("PRAGMA")).toBe(true);
    expect(getSqlFormatterProfile("ACCESS").keywords.has("TOP")).toBe(true);
    expect(getSqlFormatterProfile("unknown").keywords.has("SELECT")).toBe(true);
  });
});
