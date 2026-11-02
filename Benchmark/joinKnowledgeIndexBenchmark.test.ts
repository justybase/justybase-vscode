/**
 * JOIN Knowledge workspace-index benchmark.
 *
 * Measures a full 2,000-file index (the documented file cap), snapshot build
 * and a single-file incremental update. Results are written to
 * `Benchmark/joinKnowledgeIndex.results.md` (gitignored) for local review.
 *
 * Run: npm run benchmark:join-knowledge
 */

import { performance } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";
import {
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
} from "../src/knowledge/workspaceIndexEngine";

const FILE_COUNT = 2000;
const FILE_BYTES = 4 * 1024;
const STATEMENT = [
  "SELECT * FROM USERS u",
  "JOIN ORDERS o ON u.USER_ID = o.OWNER_ID",
  "WHERE u.ACTIVE = TRUE;",
].join("\n");

function fileText(index: number): string {
  // Comment padding keeps the on-disk size realistic without adding parser
  // work: comments are stripped before fingerprinting and parsing.
  const padding = `-- file ${index} ${"x".repeat(Math.max(0, FILE_BYTES - STATEMENT.length - 24))}`;
  return `${padding}\n${STATEMENT}\n`;
}

function inputs(): WorkspaceFileInput[] {
  return Array.from({ length: FILE_COUNT }, (_, index) => {
    const text = fileText(index);
    return {
      relPath: `sql/file_${String(index).padStart(4, "0")}.sql`,
      size: Buffer.byteLength(text, "utf8"),
      mtimeMs: 1000 + index,
      dirty: false,
      open: false,
      loadText: () => text,
    };
  });
}

function writeResults(rows: Array<{ metric: string; value: string }>): void {
  const outPath = path.join(__dirname, "joinKnowledgeIndex.results.md");
  fs.writeFileSync(
    outPath,
    [
      "# JOIN Knowledge workspace index benchmark",
      "",
      `Files: ${FILE_COUNT}, ~${FILE_BYTES} B each`,
      "",
      "| Metric | Result |",
      "|---|---|",
      ...rows.map((row) => `| ${row.metric} | ${row.value} |`),
      "",
    ].join("\n"),
  );
}

describe("JOIN knowledge workspace index benchmark", () => {
  it("indexes 2,000 files and reports full and incremental latency", async () => {
    const files = inputs();
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const engine = new WorkspaceIndexEngine({
      databaseKind: "netezza",
      salt: "0011223344556677",
      checkpointEvery: 500,
    });

    const coldStart = performance.now();
    await engine.reconcile(files);
    const coldMs = performance.now() - coldStart;

    const snapshotStart = performance.now();
    const snapshot = engine.getSnapshot();
    const snapshotMs = performance.now() - snapshotStart;

    const changed = files[42];
    const changedText = `${fileText(42)}\nSELECT * FROM CUSTOMERS c JOIN ORDERS o ON c.CUSTOMER_ID = o.CUSTOMER_ID;`;
    const changedInput: WorkspaceFileInput = {
      ...changed,
      size: Buffer.byteLength(changedText, "utf8"),
      mtimeMs: changed.mtimeMs + 1,
      loadText: () => changedText,
    };
    const incrementalStart = performance.now();
    const mutation = await engine.indexFile(changedInput);
    const incrementalMs = performance.now() - incrementalStart;

    const rows = [
      { metric: "Files indexed", value: String(engine.getFileCount()) },
      { metric: "Input bytes", value: String(totalBytes) },
      { metric: "Full index (ms)", value: coldMs.toFixed(1) },
      { metric: "Files per second", value: ((FILE_COUNT / coldMs) * 1000).toFixed(0) },
      { metric: "Snapshot build (ms)", value: snapshotMs.toFixed(1) },
      { metric: "Single-file incremental (ms)", value: incrementalMs.toFixed(1) },
      { metric: "Eligible relations", value: String(snapshot.relations.length) },
      { metric: "Delta relations upserted", value: String(mutation.delta.relationsUpsert?.length ?? 0) },
    ];
    writeResults(rows);
    console.log(JSON.stringify({ benchmark: "join-knowledge-index", ...rows }));

    expect(engine.getFileCount()).toBe(FILE_COUNT);
    expect(snapshot.relations.length).toBeGreaterThan(0);
    expect(coldMs).toBeLessThan(60_000);
    expect(incrementalMs).toBeLessThan(500);
  });
});
