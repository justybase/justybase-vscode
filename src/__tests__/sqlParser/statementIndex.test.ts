import {
  buildStatementIndex,
  diffStatementIndexes,
  groupDiagnosticsByStatement,
} from "../../sqlParser/statementIndex";
import { expandDirtyIndicesForScriptContext } from "../../sqlParser/scriptScopeStatements";
import { DocumentValidationSession } from "../../sqlParser/documentValidationSession";
import { prepareIncrementalValidation } from "../../sqlParser/validationPipeline";
import type { ValidationError } from "../../sqlParser/types";

describe("statementIndex", () => {
  it("builds statement boundaries with stable hashes", () => {
    const sql = "SELECT 1;\n\nSELECT 2 FROM T;";

    const index = buildStatementIndex(sql);

    expect(index.statements).toHaveLength(2);
    expect(index.statements[0]).toMatchObject({
      index: 0,
      startOffset: 0,
      endOffset: 8,
      sql: "SELECT 1",
    });
    expect(index.statements[1]).toMatchObject({
      index: 1,
      startOffset: 11,
      endOffset: sql.length - 1,
      sql: "SELECT 2 FROM T",
    });
    expect(index.statements[0].contentHash).toBe(
      buildStatementIndex(sql).statements[0].contentHash,
    );
  });

  it("marks no statements dirty when document content is unchanged", () => {
    const index = buildStatementIndex("SELECT 1; SELECT 2;");

    expect(diffStatementIndexes(index, index)).toEqual({
      dirtyIndices: [],
      affectedFromIndex: 2,
    });
  });

  it("marks only edited same-position statements dirty", () => {
    const previous = buildStatementIndex("SELECT 1; SELECT 2; SELECT 3;");
    const next = buildStatementIndex("SELECT 1; SELECT 20; SELECT 3;");

    expect(diffStatementIndexes(previous, next)).toEqual({
      dirtyIndices: [1],
      affectedFromIndex: 1,
    });
  });

  it("marks downstream statements dirty when insertion shifts indexes", () => {
    const previous = buildStatementIndex("SELECT 1; SELECT 3;");
    const next = buildStatementIndex("SELECT 1; SELECT 2; SELECT 3;");

    expect(diffStatementIndexes(previous, next)).toEqual({
      dirtyIndices: [1, 2],
      affectedFromIndex: 1,
    });
  });

  it("expands dirty indices downstream when a DROP statement changes", () => {
    const previous = buildStatementIndex(
      "CREATE TEMP TABLE MY_TEMP (ID INT4);\nDROP TABLE MY_TEMP;\nSELECT ID FROM MY_TEMP;",
    );
    const next = buildStatementIndex(
      "CREATE TEMP TABLE MY_TEMP (ID INT4);\nDROP TABLE IF EXISTS MY_TEMP;\nSELECT ID FROM MY_TEMP;",
    );
    const diff = diffStatementIndexes(previous, next);

    expect(diff.dirtyIndices).toEqual([1]);
    expect(
      expandDirtyIndicesForScriptContext(previous, next, diff.dirtyIndices),
    ).toEqual([1, 2]);
  });

  it("expands dirty indices downstream when an ALTER TABLE statement changes", () => {
    const previous = buildStatementIndex(
      "CREATE TABLE T (ID INT4);\nALTER TABLE T ADD COLUMN NAME VARCHAR(10);\nSELECT NAME FROM T;",
    );
    const next = buildStatementIndex(
      "CREATE TABLE T (ID INT4);\nALTER TABLE T ADD COLUMN EMAIL VARCHAR(100);\nSELECT NAME FROM T;",
    );
    const diff = diffStatementIndexes(previous, next);

    expect(diff.dirtyIndices).toEqual([1]);
    expect(
      expandDirtyIndicesForScriptContext(previous, next, diff.dirtyIndices),
    ).toEqual([1, 2]);
  });
});

describe("DocumentValidationSession", () => {
  const uri = "file:///validation-session.sql";

  it("tracks previous index and caches diagnostics by statement hash", () => {
    const session = new DocumentValidationSession();
    const first = session.prepareDocument(uri, "SELECT 1; SELECT 2;");

    expect(first.diff.dirtyIndices).toEqual([0, 1]);
    session.storeStatementDiagnostics(uri, first.nextIndex.statements[0], [
      {
        message: "example",
        severity: "warning",
        position: {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 2,
          offset: 0,
        },
        code: "SQL999",
      },
    ]);
    session.commitDocumentIndex(uri, first.nextIndex);

    const second = session.prepareDocument(uri, "SELECT 1; SELECT 20;");
    expect(second.diff.dirtyIndices).toEqual([1]);
    expect(
      session.getCachedDiagnostics(uri, second.nextIndex.statements[0]),
    ).toHaveLength(1);
    expect(
      session.getCachedDiagnostics(uri, second.nextIndex.statements[1]),
    ).toBeUndefined();
  });

  it("invalidates all cached state for a document", () => {
    const session = new DocumentValidationSession();
    const first = session.prepareDocument(uri, "SELECT 1;");
    session.commitDocumentIndex(uri, first.nextIndex);
    session.invalidateDocument(uri);

    const next = session.prepareDocument(uri, "SELECT 1;");

    expect(next.previousIndex).toBeUndefined();
    expect(next.diff.dirtyIndices).toEqual([0]);
  });

  it("drops cached diagnostics when metadata epoch changes", () => {
    const session = new DocumentValidationSession();
    const first = session.prepareDocument(uri, "SELECT 1; SELECT 2;");
    session.storeStatementDiagnostics(
      uri,
      first.nextIndex.statements[0],
      [
        {
          message: "stale",
          severity: "warning",
          position: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 2,
            offset: 0,
          },
          code: "SQL999",
        },
      ],
      1,
    );
    session.commitDocumentIndex(uri, first.nextIndex);

    const second = session.prepareDocument(uri, "SELECT 1; SELECT 20;");
    session.syncMetadataEpoch(uri, 2);

    expect(
      session.getCachedDiagnostics(uri, second.nextIndex.statements[0], 2),
    ).toBeUndefined();
  });

  it("keeps incremental coverage for more than 512 statements", () => {
    const sql = Array.from(
      { length: 1200 },
      (_, index) => `SELECT ${index};`,
    ).join("\n");
    const session = new DocumentValidationSession();
    const first = session.prepareDocument(uri, sql);
    for (const statement of first.nextIndex.statements) {
      session.storeStatementDiagnostics(uri, statement, []);
    }
    session.commitDocumentIndex(uri, first.nextIndex);

    const edited = sql.replace("SELECT 0;", "SELECT 9999;");
    const prepared = prepareIncrementalValidation({
      documentUri: uri,
      sql: edited,
      validationSession: session,
      requireFullCacheCoverage: true,
    });

    expect(prepared.incrementalValidation).toBeDefined();
    expect(prepared.incrementalValidation?.dirtyIndices).toEqual([0]);
    expect(prepared.incrementalValidation?.cachedDiagnostics.size).toBe(1199);
  });
});

describe("groupDiagnosticsByStatement", () => {
  function diagnostic(offset: number, code = "SQL999"): ValidationError {
    return {
      message: code,
      severity: "warning",
      position: {
        startLine: 1,
        startColumn: offset + 1,
        endLine: 1,
        endColumn: offset + 2,
        offset,
      },
      code,
    };
  }

  it("assigns diagnostics with binary search and preserves their order", () => {
    const index = buildStatementIndex(
      "SELECT 1;\nSELECT 2;\nSELECT 3;",
    );
    const first = diagnostic(index.statements[0].startOffset + 1, "A");
    const thirdEarly = diagnostic(index.statements[2].startOffset + 1, "B");
    const thirdLate = diagnostic(index.statements[2].startOffset + 5, "C");

    const grouped = groupDiagnosticsByStatement(
      index.statements,
      [thirdLate, first, thirdEarly],
    );

    expect(grouped.get(0)).toEqual([first]);
    expect(grouped.get(2)).toEqual([thirdLate, thirdEarly]);
    expect(grouped.get(1)).toBeUndefined();
  });

  it("ignores diagnostics outside every statement range", () => {
    const index = buildStatementIndex("SELECT 1;");
    const grouped = groupDiagnosticsByStatement(index.statements, [
      diagnostic(-1),
      diagnostic(index.statements[0].endOffset + 1),
    ]);

    expect(grouped.size).toBe(0);
  });
});
