import {
  HARD_SQL_FILE_MAX_BYTES,
  SOFT_SQL_FILE_WARN_BYTES,
  isElectronSqlFile,
  isElectronSqlFilePath,
  isElectronSqlSaveResult,
} from "../src/index";

describe("Electron SQL file contracts", () => {
  it("exposes soft/hard byte budgets", () => {
    expect(SOFT_SQL_FILE_WARN_BYTES).toBe(2 * 1024 * 1024);
    expect(HARD_SQL_FILE_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("accepts only .sql paths", () => {
    expect(isElectronSqlFilePath("/tmp/report.sql")).toBe(true);
    expect(isElectronSqlFilePath("C:\\work\\report.SQL")).toBe(true);
    expect(isElectronSqlFilePath("/tmp/notes.txt")).toBe(false);
    expect(isElectronSqlFilePath("")).toBe(false);
    expect(isElectronSqlFilePath("/tmp/bad\0.sql")).toBe(false);
  });

  it("validates file payloads and save results", () => {
    const file = { filePath: "/tmp/report.sql", fileName: "report.sql", content: "SELECT 1;", sizeBytes: 9, oversize: false };
    expect(isElectronSqlFile(file)).toBe(true);
    expect(isElectronSqlFile({ ...file, filePath: "/tmp/notes.txt" })).toBe(false);
    expect(isElectronSqlFile({ ...file, sizeBytes: HARD_SQL_FILE_MAX_BYTES + 1 })).toBe(false);
    expect(isElectronSqlSaveResult({ filePath: "/tmp/report.sql", fileName: "report.sql", sizeBytes: 9 })).toBe(true);
    expect(isElectronSqlSaveResult({ filePath: "/tmp/report.sql", fileName: "report.sql", sizeBytes: -1 })).toBe(false);
  });
});
