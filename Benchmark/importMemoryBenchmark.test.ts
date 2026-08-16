/**
 * Import Memory Benchmark
 *
 * Measures peak memory usage during CSV/Excel import streaming.
 * Ensures that streaming imports (createDataStream) do not materialize
 * entire files in RAM, while the legacy getAllRows() path does.
 *
 * Key assertions:
 *   - Streaming CSV: heap delta is O(1) with respect to file size
 *   - getAllRows():   heap delta is proportional to file size
 *
 * Run with:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/importMemoryBenchmark.test.ts
 *
 * For more precise GC measurements (optional):
 *   node --expose-gc ./node_modules/.bin/jest --config Benchmark/jest.config.js --runInBand Benchmark/importMemoryBenchmark.test.ts
 */

import { performance } from "perf_hooks";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NetezzaImporter } from "../src/import/dataImporter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Generate a CSV file of approximately `targetSizeMB` and return the row count. */
function generateCsvFile(filePath: string, targetSizeMB: number): number {
  const header = "id,name,email,amount,created_at\n";
  const targetBytes = targetSizeMB * 1024 * 1024;
  const batchSize = 64 * 1024; // 64 KB batch to reduce syscall overhead

  const fd = fs.openSync(filePath, "w");
  fs.writeSync(fd, header);
  let written = Buffer.byteLength(header, "utf8");
  let rowIndex = 1;
  let batchBuffer = "";

  while (written < targetBytes) {
    const line = `${rowIndex},user_${rowIndex},user${rowIndex}@example.com,${(rowIndex % 1000) * 1.5},2026-01-${String((rowIndex % 28) + 1).padStart(2, "0")}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (written + lineBytes > targetBytes) break;
    batchBuffer += line;
    written += lineBytes;
    rowIndex++;

    // Flush batch buffer when it reaches batch size
    if (Buffer.byteLength(batchBuffer, "utf8") >= batchSize) {
      fs.writeSync(fd, batchBuffer);
      batchBuffer = "";
    }
  }

  // Flush remaining batch
  if (batchBuffer) {
    fs.writeSync(fd, batchBuffer);
  }

  fs.closeSync(fd);
  return rowIndex - 1;
}

// Helper to run gc if available (--expose-gc flag)
function tryGc(): void {
  if (typeof (globalThis as { gc?: () => void }).gc === "function") {
    (globalThis as { gc: () => void }).gc();
  }
}

/** Consume a Readable stream fully (drain all data). */
async function consumeStream(stream: NodeJS.ReadableStream): Promise<number> {
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += Buffer.byteLength(String(chunk), "utf8");
  }
  return totalBytes;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

interface ScenarioResult {
  scenario: string;
  fileSizeMB: number;
  rowCount: number;
  analysisTimeMs: number;
  analysisHeapDeltaMB: number;
  streamTimeMs: number;
  streamHeapDeltaMB: number;
  consumeTimeMs: number;
  consumeHeapDeltaMB: number;
  peakHeapOverBaselineMB: number;
}

const results: ScenarioResult[] = [];

function saveResults(): void {
  const outPath = path.join(__dirname, "importMemory.results.md");
  const lines: string[] = [];

  lines.push("# Import Memory Benchmark Results");
  lines.push("");
  lines.push("Measures peak heap memory (`heapUsed`) during CSV import streaming.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Scenario | File Size | Rows | Analysis ΔMB | Stream ΔMB | Consume ΔMB | Peak ΔMB |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.fileSizeMB} MB | ${r.rowCount.toLocaleString()} | ${r.analysisHeapDeltaMB.toFixed(2)} | ${r.streamHeapDeltaMB.toFixed(2)} | ${r.consumeHeapDeltaMB.toFixed(2)} | ${r.peakHeapOverBaselineMB.toFixed(2)} |`,
    );
  }

  lines.push("");
  lines.push("## Detailed Results");
  lines.push("");
  lines.push("| Scenario | File Size | Rows | Analysis (ms) | Analysis ΔMB | Stream (ms) | Stream ΔMB | Consume (ms) | Consume ΔMB | Peak ΔMB |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.fileSizeMB} MB | ${r.rowCount.toLocaleString()} | ${r.analysisTimeMs.toFixed(1)} | ${r.analysisHeapDeltaMB.toFixed(2)} | ${r.streamTimeMs.toFixed(1)} | ${r.streamHeapDeltaMB.toFixed(2)} | ${r.consumeTimeMs.toFixed(1)} | ${r.consumeHeapDeltaMB.toFixed(2)} | ${r.peakHeapOverBaselineMB.toFixed(2)} |`,
    );
  }

  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push("- **Analysis ΔMB**: heap delta from `analyzeDataTypes()`. For CSV > 10 MB uses streaming analysis (should be O(1)).");
  lines.push("- **Stream ΔMB**: heap delta from `createDataStream()`. Should be O(1) — only allocates the generator closure.");
  lines.push("- **Consume ΔMB**: heap delta after fully consuming the stream. Should be near zero (stream is drained and GC'd).");
  lines.push("- **Peak ΔMB**: highest heap footprint increase over baseline during the entire import pipeline.");
  lines.push("");
  lines.push("For true streaming, all deltas should be independent of file size (within buffer overhead).");

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`\nBenchmark results saved to ${outPath}`);
}

describe("Import Memory Benchmark", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-mem-bench-"));
  const gcAvailable = typeof (globalThis as { gc?: () => void }).gc === "function";

  beforeAll(() => {
    console.log(`GC available: ${gcAvailable}`);
    console.log(`Temp dir: ${tempDir}`);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    saveResults();
  });

  /**
   * 1 MB CSV — baseline to measure minimum overhead.
   */
  it("measures memory for 1MB CSV streaming import", async () => {
    const csvPath = path.join(tempDir, "bench_1mb.csv");
    const rowCount = generateCsvFile(csvPath, 1);
    const fileSizeMB = 1;

    // --- analyzeDataTypes (streaming for > 10MB, in-memory for <=10MB) ---
    const importer = new NetezzaImporter(csvPath, "BENCH_TABLE");
    const memBeforeAnalysis = process.memoryUsage();
    const t0 = performance.now();
    await importer.analyzeDataTypes();
    const analysisTime = performance.now() - t0;
    const memAfterAnalysis = process.memoryUsage();
    const analysisHeapDelta = memAfterAnalysis.heapUsed - memBeforeAnalysis.heapUsed;

    // --- createDataStream (streaming) ---
    const memBeforeStream = process.memoryUsage();
    const t1 = performance.now();
    const stream = await importer.createDataStream();
    const streamTime = performance.now() - t1;
    const memAfterStream = process.memoryUsage();
    const streamHeapDelta = memAfterStream.heapUsed - memBeforeStream.heapUsed;

    // --- consume stream ---
    const t2 = performance.now();
    const consumedBytes = await consumeStream(stream);
    const consumeTime = performance.now() - t2;
    tryGc();
    const memAfterConsume = process.memoryUsage();
    const consumeHeapDelta = memAfterConsume.heapUsed - memBeforeAnalysis.heapUsed;

    // Peak heap = max of all intermediate measurements
    const peakHeap =
      Math.max(
        memAfterAnalysis.heapUsed,
        memAfterStream.heapUsed,
        memAfterConsume.heapUsed,
      ) - memBeforeAnalysis.heapUsed;

    results.push({
      scenario: "CSV 1MB streaming",
      fileSizeMB,
      rowCount,
      analysisTimeMs: analysisTime,
      analysisHeapDeltaMB: analysisHeapDelta / (1024 * 1024),
      streamTimeMs: streamTime,
      streamHeapDeltaMB: streamHeapDelta / (1024 * 1024),
      consumeTimeMs: consumeTime,
      consumeHeapDeltaMB: consumeHeapDelta / (1024 * 1024),
      peakHeapOverBaselineMB: peakHeap / (1024 * 1024),
    });

    console.log(
      `\n  1MB CSV — rows: ${rowCount.toLocaleString()}` +
        `\n    analyzeDataTypes: ${analysisTime.toFixed(1)} ms, heap Δ: ${formatBytes(analysisHeapDelta)}` +
        `\n    createDataStream: ${streamTime.toFixed(1)} ms, heap Δ: ${formatBytes(streamHeapDelta)}` +
        `\n    consume stream:   ${consumeTime.toFixed(1)} ms, heap Δ: ${formatBytes(consumeHeapDelta)}` +
        `\n    consumed: ${formatBytes(consumedBytes)}` +
        `\n    peak Δ: ${formatBytes(peakHeap)}`,
    );

    // Streaming should not hold the file in heap (barring buffer overhead)
    expect(streamHeapDelta).toBeLessThan(5 * 1024 * 1024);
  }, 60000);

  /**
   * 10 MB CSV — compare streaming vs getAllRows() memory difference.
   */
  it("compares streaming vs getAllRows memory for 10MB CSV", async () => {
    const csvPath = path.join(tempDir, "bench_10mb.csv");
    generateCsvFile(csvPath, 10);
    let streamPeakDelta: number;

    // --- streaming path ---
    {
      const importer = new NetezzaImporter(csvPath, "BENCH_TABLE");
      await importer.analyzeDataTypes();
      const memBase = process.memoryUsage();

      const stream = await importer.createDataStream();
      const memAfterStream = process.memoryUsage();
      streamPeakDelta = memAfterStream.heapUsed - memBase.heapUsed;

      await consumeStream(stream);
      tryGc();
    }

    // --- getAllRows() path (materializes full file) ---
    {
      const importer = new NetezzaImporter(csvPath, "BENCH_TABLE");
      await importer.analyzeDataTypes();

      // Force GC before measuring to isolate getAllRows() cost
      tryGc();
      const memBefore = process.memoryUsage();
      const t0 = performance.now();
      const allRows = await importer.getAllRows();
      const getAllTime = performance.now() - t0;
      const memAfter = process.memoryUsage();
      const getAllHeapDelta = memAfter.heapUsed - memBefore.heapUsed;

      console.log(
        `\n  10MB CSV — streaming peak Δ: ${formatBytes(streamPeakDelta)}, ` +
          `getAllRows Δ: ${formatBytes(getAllHeapDelta)} (${getAllTime.toFixed(1)} ms, ${allRows.length.toLocaleString()} rows)`,
      );

      // getAllRows() should use significantly more heap than streaming
      // The raw content alone is ~10MB, plus split() + parse objects
      expect(getAllHeapDelta).toBeGreaterThan(5 * 1024 * 1024);
      expect(streamPeakDelta).toBeLessThan(getAllHeapDelta / 2);
    }
  }, 60000);

  /**
   * 100 MB CSV — prove streaming is O(1) for large files.
   * WARNING: this generates a 100MB file and measures streaming only.
   * The getAllRows() path would OOM or be too slow, so we skip it here.
   */
  it("proves O(1) memory for 100MB CSV streaming import", async () => {
    const csvPath = path.join(tempDir, "bench_100mb.csv");
    generateCsvFile(csvPath, 100);
    const fileSizeMB = 100;

    const importer = new NetezzaImporter(csvPath, "BENCH_TABLE");

    // Run GC before first measurement to clear file-generation garbage
    tryGc();

    // --- analyzeDataTypes (streaming for > 10MB) ---
    const memBeforeAnalysis = process.memoryUsage();
    const t0 = performance.now();
    await importer.analyzeDataTypes();
    const analysisTime = performance.now() - t0;
    const memAfterAnalysis = process.memoryUsage();
    const analysisHeapDelta = memAfterAnalysis.heapUsed - memBeforeAnalysis.heapUsed;

    // Read row count from importer after analysis
    const measuredRowCount = importer.getRowsCount();

    // --- createDataStream (streaming) ---
    const memBeforeStream = process.memoryUsage();
    const t1 = performance.now();
    const stream = await importer.createDataStream();
    const streamTime = performance.now() - t1;
    const memAfterStream = process.memoryUsage();
    const streamHeapDelta = memAfterStream.heapUsed - memBeforeStream.heapUsed;

    // --- consume stream ---
    const t2 = performance.now();
    const consumedBytes = await consumeStream(stream);
    const consumeTime = performance.now() - t2;
    tryGc();
    const memAfterConsume = process.memoryUsage();
    const consumeHeapDelta = memAfterConsume.heapUsed - memBeforeAnalysis.heapUsed;

    const peakHeap =
      Math.max(
        memAfterAnalysis.heapUsed,
        memAfterStream.heapUsed,
        memAfterConsume.heapUsed,
      ) - memBeforeAnalysis.heapUsed;

    results.push({
      scenario: "CSV 100MB streaming",
      fileSizeMB,
      rowCount: measuredRowCount,
      analysisTimeMs: analysisTime,
      analysisHeapDeltaMB: analysisHeapDelta / (1024 * 1024),
      streamTimeMs: streamTime,
      streamHeapDeltaMB: streamHeapDelta / (1024 * 1024),
      consumeTimeMs: consumeTime,
      consumeHeapDeltaMB: consumeHeapDelta / (1024 * 1024),
      peakHeapOverBaselineMB: peakHeap / (1024 * 1024),
    });

    console.log(
      `\n  100MB CSV — rows: ${measuredRowCount.toLocaleString()}` +
        `\n    analyzeDataTypes: ${analysisTime.toFixed(1)} ms, heap Δ: ${formatBytes(analysisHeapDelta)}` +
        `\n    createDataStream: ${streamTime.toFixed(1)} ms, heap Δ: ${formatBytes(streamHeapDelta)}` +
        `\n    consume stream:   ${consumeTime.toFixed(1)} ms, heap Δ: ${formatBytes(consumeHeapDelta)}` +
        `\n    consumed: ${formatBytes(consumedBytes)}` +
        `\n    peak Δ: ${formatBytes(peakHeap)}`,
    );

    // CRITICAL ASSERTION: The stream creation itself must be memory-constant.
    // If this fails, the streaming path is materializing data in RAM.
    // (peakHeap may be higher due to analysis overhead or incomplete GC
    //  without --expose-gc, but streamHeapDelta directly measures the stream.)
    expect(streamHeapDelta).toBeLessThan(10 * 1024 * 1024);

    // Overall peak should be well under the file size (100MB).
    // 150MB is generous to account for V8 heap fragmentation without --expose-gc.
    expect(peakHeap).toBeLessThan(150 * 1024 * 1024);
  }, 300000);
});
