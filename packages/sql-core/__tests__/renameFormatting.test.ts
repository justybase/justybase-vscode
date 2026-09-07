import { formatSqlRenameReplacement } from "../src/renameFormatting";

describe("sql-core rename formatting", () => {
  it("preserves quoting and escapes embedded quotes", () => {
    expect(formatSqlRenameReplacement('"Old Name"', ' New "Name" ')).toBe('"New ""Name"""');
    expect(formatSqlRenameReplacement('PLAIN', ' "New Name" ')).toBe("New Name");
  });
});
