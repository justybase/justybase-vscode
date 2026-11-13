#!/usr/bin/env node
/**
 * Full LSP diagnostics-pipeline benchmark.
 *
 * Runs the real `createDiagnosticsHandler` (metadata bridge, incremental
 * validation sessions, statement index, parser/validator, diagnostics
 * conversion) in-process against the same NZPLSQL fixtures as the parser
 * benchmark. The fake connection only replaces JSON-RPC transport; metadata
 * responses are deterministic stubs so the numbers reflect CPU work, not a
 * database.
 *
 * The production diagnostics cutoffs are overridden through the
 * `diagnosticsLimits` dependency so the pipeline can be measured above the
 * public defaults. Production code keeps using `validationConfig` unless a
 * caller explicitly opts out.
 *
 * Run: npm run benchmark:lsp-pipeline
 * Enforce budgets: LSP_PIPELINE_ENFORCE=1 npm run benchmark:lsp-pipeline
 */
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const { performance } = require("perf_hooks");
const { TextDocument } = require("vscode-languageserver-textdocument");

const repoRoot = path.resolve(__dirname, "..");

// ts-node does not expand tsconfig `paths`; map the workspace aliases used by
// the server modules to their TypeScript sources.
const tsconfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8"),
);
const pathAliases = tsconfig.compilerOptions.paths;

function resolveAlias(request) {
  for (const [pattern, targets] of Object.entries(pathAliases)) {
    const target = targets[0];
    if (pattern.includes("*")) {
      const [prefix, suffix] = pattern.split("*");
      if (request.startsWith(prefix) && request.endsWith(suffix)) {
        const middle = request.slice(
          prefix.length,
          request.length - suffix.length,
        );
        return path.join(repoRoot, target.replace("*", middle));
      }
    } else if (request === pattern) {
      return path.join(repoRoot, target);
    }
  }
  return undefined;
}

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const alias = resolveAlias(request);
  if (alias) {
    return originalResolveFilename.call(this, alias, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require("ts-node/register/transpile-only");

const {
  createDiagnosticsHandler,
} = require("../src/server/handlers/diagnosticsHandler");
const { MetadataBridge } = require("../src/server/metadataBridge");
const {
  DocumentParseSession,
  DocumentValidationSession,
} = require("../src/sqlParser");
const {
  DEFAULT_LINT_DEBOUNCE_MS,
  LARGE_SCRIPT_LINT_DEBOUNCE_MS,
  LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD,
} = require("../src/sqlParser/validationConfig");

const WARMUP_RUNS = 1;
const ITERATIONS = 3;
const ENFORCE_BUDGET = process.env.LSP_PIPELINE_ENFORCE === "1";
const TEN_THOUSAND_COLD_BUDGET_MS = 1_000;
const TEN_THOUSAND_WARM_BUDGET_MS = 600;

function generateProcedure(targetLines, syntaxError) {
  const lines = [
    "CREATE OR REPLACE PROCEDURE BENCH.PUBLIC.LARGE_PROC(A INT)",
    "RETURNS INT",
    "LANGUAGE NZPLSQL AS",
    "BEGIN_PROC",
    "DECLARE",
    "    v_total INT;",
    "    v_counter INT;",
    "BEGIN",
    "    v_total := 0;",
    "    v_counter := 0;",
  ];

  let block = 0;
  while (lines.length < targetLines - 10) {
    lines.push(`    v_total := v_total + ${block % 7};`);
    lines.push(`    INSERT INTO BENCH..T${block % 5} VALUES (${block % 100});`);
    lines.push("    IF v_total > 1000 THEN");
    lines.push("        v_total := v_total - 1000;");
    lines.push("    END IF;");
    block += 1;
  }

  if (syntaxError) {
    lines.push("    SELECT FROM BENCH..BROKEN;");
  }

  lines.push("    RETURN v_total;");
  lines.push("END;");
  lines.push("END_PROC;");
  return lines.join("\n");
}

function generateStatements(targetLines) {
  const lines = [];
  for (let index = 0; index < targetLines; index += 1) {
    lines.push(`INSERT INTO BENCH..T${index % 5} VALUES (${index});`);
  }
  return lines.join("\n");
}

function buildFixtures() {
  const fixtures = [
    { name: "Valid 3k", targetLines: 3_000, syntaxError: false },
    { name: "Valid 5k", targetLines: 5_000, syntaxError: false },
    { name: "Valid 10k", targetLines: 10_000, syntaxError: false },
    { name: "Invalid 10k", targetLines: 10_000, syntaxError: true },
    { name: "Valid 15k", targetLines: 15_000, syntaxError: false },
    { name: "Valid 20k", targetLines: 20_000, syntaxError: false },
    { name: "Multi 5k", targetLines: 5_000, syntaxError: false, generator: "statements" },
    { name: "Multi 10k", targetLines: 10_000, syntaxError: false, generator: "statements" },
  ];

  return fixtures.map((fixture) => {
    const sql =
      fixture.generator === "statements"
        ? generateStatements(fixture.targetLines)
        : generateProcedure(fixture.targetLines, fixture.syntaxError);
    const changedSql = fixture.generator === "statements"
      ? sql.replace("VALUES (0);", "VALUES (9999);")
      : sql.includes("v_total := v_total + 1;")
        ? sql.replace(
            "v_total := v_total + 1;",
            "v_total := v_total + 2;",
          )
        : `${sql}\n-- edited`;
    return {
      ...fixture,
      sql,
      changedSql,
      lines: sql.split("\n").length,
      chars: sql.length,
    };
  });
}

const COLUMNS = [
  { name: "ID", type: "INT4" },
  { name: "NAME", type: "VARCHAR" },
];

function createMetadataBridge(counters) {
  const sendRequest = async (params) => {
    counters.requests += 1;
    counters.byKind[params.kind] = (counters.byKind[params.kind] || 0) + 1;
    switch (params.kind) {
      case "context":
        return {
          connectionName: "bench",
          databaseKind: "netezza",
          effectiveDatabase: "BENCH",
          effectiveSchema: "PUBLIC",
          serverVersionNum: 11,
        };
      case "cachedTableInfo":
      case "tableInfo":
        return {
          exists: true,
          table: params.table,
          database: params.database,
          schema: params.schema,
          columns: COLUMNS,
          columnsComplete: true,
        };
      case "columns":
        return COLUMNS;
      case "qualifyTable":
        return [];
      default:
        return [];
    }
  };
  return new MetadataBridge(sendRequest, { error() {} });
}

function createFakeConnection(state) {
  return {
    sendDiagnostics(params) {
      state.onDiagnostics?.(params.diagnostics);
    },
    sendNotification: async () => {},
    console: {
      log: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    },
    workspace: {
      getConfiguration: async () => ({}),
    },
  };
}

function createHarness(limits, counters = { requests: 0, byKind: {} }) {
  const state = { onDiagnostics: null, lastPipelineMs: null };
  const connection = createFakeConnection(state);
  // Capture the handler's own timer through the UX-perf notification.
  connection.sendNotification = async (_method, params) => {
    if (params?.op === "lsp.diagnostics" && params?.phase === "end") {
      state.lastPipelineMs = params.durationMs;
    }
  };
  const metadataBridge = createMetadataBridge(counters);
  const documentParseSession = new DocumentParseSession();
  const documentValidationSession = new DocumentValidationSession();
  const handler = createDiagnosticsHandler({
    connection,
    metadataBridge,
    documentParseSession,
    documentValidationSession,
    diagnosticsLimits: limits,
  });
  return { handler, state, counters };
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function debounceFor(document) {
  return document.lineCount > LSP_LARGE_DIAGNOSTICS_LINE_THRESHOLD
    ? LARGE_SCRIPT_LINT_DEBOUNCE_MS
    : DEFAULT_LINT_DEBOUNCE_MS;
}

function runDocument(harness, document) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      harness.state.onDiagnostics = null;
      reject(new Error(`Timed out waiting for diagnostics for ${document.uri}`));
    }, 60_000);
    const start = performance.now();
    harness.state.onDiagnostics = (diagnostics) => {
      clearTimeout(timeout);
      harness.state.onDiagnostics = null;
      const wallMs = performance.now() - start - debounceFor(document);
      // The handler emits its own timing notification after sendDiagnostics;
      // wait one macrotask so it is captured too.
      setImmediate(() => {
        resolve({
          wallMs,
          pipelineMs: harness.state.lastPipelineMs,
          diagnostics: diagnostics.length,
        });
      });
    };
    harness.state.lastPipelineMs = null;
    harness.handler.scheduleDiagnostics(document);
  });
}

function measureCold(fixture, limits, counters) {
  const harness = createHarness(limits, counters);
  const document = TextDocument.create(
    `file:///bench/${fixture.name.replace(/\s+/g, "-")}-cold.sql`,
    "sql",
    1,
    fixture.sql,
  );
  return runDocument(harness, document);
}

function measureWarm(fixture, limits, counters) {
  const harness = createHarness(limits, counters);
  const uri = `file:///bench/${fixture.name.replace(/\s+/g, "-")}-warm.sql`;
  const coldDocument = TextDocument.create(uri, "sql", 1, fixture.sql);
  return runDocument(harness, coldDocument).then(async () => {
    let version = 1;
    let document = coldDocument;
    const results = [];
    for (let index = 0; index < ITERATIONS; index += 1) {
      version += 1;
      document = TextDocument.create(
        uri,
        "sql",
        version,
        index % 2 === 0 ? fixture.changedSql : fixture.sql,
      );
      results.push(await runDocument(harness, document));
    }
    return results;
  });
}

function writeResults(rows) {
  const cpu = os.cpus()[0]?.model ?? "unknown CPU";
  const lines = [
    "# LSP Diagnostics Pipeline Benchmark",
    "",
    `Generated at ${new Date().toISOString()}.`,
    "",
    `Environment: Node ${process.version}, ${os.platform()} ${os.arch()}, ${cpu}.`,
    "",
    "Runs the real `createDiagnosticsHandler` with real metadata bridge, parse/validation",
    "sessions, incremental validation, statement indexing, and diagnostics conversion.",
    "Only JSON-RPC transport and metadata I/O are stubbed; the stubs resolve instantly, so",
    "the values are CPU-bound pipeline cost.",
    "",
    "The production diagnostics cutoffs are overridden for this benchmark so 5k/10k/15k/20k",
    "procedure documents and 5k/10k short-statement scripts reach the pipeline instead of being",
    "short-circuited. `Cold` is the first validation of a document with fresh sessions; `Warm` is a",
    "small in-place edit with the same sessions and metadata cache. Wall times exclude the LSP",
    "debounce (2 s above 1500 lines).",
    "",
    "| Document | Lines | Chars | Cold median | Cold P95 | Warm median | Warm P95 | Handler cold | Handler warm | Diagnostics | Metadata requests/run |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.doc} | ${row.lines.toLocaleString()} | ${row.chars.toLocaleString()} `
        + `| ${row.cold.median.toFixed(1)} ms | ${row.cold.p95.toFixed(1)} ms `
        + `| ${row.warm.median.toFixed(1)} ms | ${row.warm.p95.toFixed(1)} ms `
        + `| ${row.coldPipeline.median.toFixed(1)} ms | ${row.warmPipeline.median.toFixed(1)} ms `
        + `| ${row.diagnostics} | ${row.metadataRequests} |`,
    ),
    "",
    "## Notes",
    "",
    "- Cold includes `getContext`, incremental-validation warmup, metadata warmup, full parse/validation, and diagnostics conversion.",
    "- Warm includes the same path with cached sessions; it approximates the work after a short typing pause.",
    "- The procedure fixtures are one large `CREATE PROCEDURE` statement, so an edit invalidates the whole statement; their warm rows are the realistic worst case.",
    "- Multi-statement fixtures show the per-statement incremental path; indexing still scans the document, so warm is close to cold.",
    "- `Handler cold/warm` is the handler's own `lsp.diagnostics` timer (metadata warmup + validation + send), excluding the initial context lookup and statement indexing.",
    "",
  ];
  fs.writeFileSync(
    path.join(__dirname, "lspPipeline.results.md"),
    lines.join("\n"),
  );
}

async function measureFixture(fixture, limits) {
  const coldCounters = { requests: 0, byKind: {} };
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    await measureCold(fixture, limits, coldCounters);
  }
  const cold = [];
  const coldResults = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const result = await measureCold(fixture, limits, coldCounters);
    cold.push(result.wallMs);
    coldResults.push(result);
  }

  const warmCounters = { requests: 0, byKind: {} };
  const warmResults = await measureWarm(fixture, limits, warmCounters);
  const warm = warmResults.map((result) => result.wallMs);

  return {
    doc: fixture.name,
    lines: fixture.lines,
    chars: fixture.chars,
    cold: stats(cold),
    warm: stats(warm),
    diagnostics: coldResults[0]?.diagnostics ?? 0,
    metadataRequests:
      Math.round(coldCounters.requests / (WARMUP_RUNS + ITERATIONS))
      + Math.round(warmCounters.requests / (ITERATIONS + 1)),
    coldPipeline: stats(
      coldResults
        .map((result) => result.pipelineMs)
        .filter((value) => typeof value === "number"),
    ),
    warmPipeline: stats(
      warmResults
        .map((result) => result.pipelineMs)
        .filter((value) => typeof value === "number"),
    ),
  };
}

async function main() {
  const fixtures = buildFixtures();
  const limits = {
    maxTextLength: Number.MAX_SAFE_INTEGER,
    maxLineCount: Number.MAX_SAFE_INTEGER,
  };
  const rows = [];
  for (const fixture of fixtures) {
    const row = await measureFixture(fixture, limits);
    rows.push(row);
    console.log(
      `${row.doc}: cold ${row.cold.median.toFixed(1)} ms, warm ${row.warm.median.toFixed(1)} ms`,
    );
  }

  writeResults(rows);
  console.table(
    rows.map((row) => ({
      Document: row.doc,
      Lines: row.lines,
      "Cold ms": row.cold.median.toFixed(1),
      "Cold P95": row.cold.p95.toFixed(1),
      "Warm ms": row.warm.median.toFixed(1),
      "Warm P95": row.warm.p95.toFixed(1),
      "Handler cold ms": row.coldPipeline.median.toFixed(1),
      "Handler warm ms": row.warmPipeline.median.toFixed(1),
      Diagnostics: row.diagnostics,
    })),
  );
  console.log(
    `\nResults written to ${path.join(__dirname, "lspPipeline.results.md")}`,
  );

  if (!ENFORCE_BUDGET) {
    return;
  }

  const tenK = rows.find((row) => row.doc === "Valid 10k");
  if (!tenK) {
    throw new Error("Missing Valid 10k fixture.");
  }
  if (tenK.cold.median > TEN_THOUSAND_COLD_BUDGET_MS) {
    throw new Error(
      `Valid 10k cold median ${tenK.cold.median.toFixed(1)} ms exceeds `
      + `the ${TEN_THOUSAND_COLD_BUDGET_MS} ms budget.`,
    );
  }
  if (tenK.warm.median > TEN_THOUSAND_WARM_BUDGET_MS) {
    throw new Error(
      `Valid 10k warm median ${tenK.warm.median.toFixed(1)} ms exceeds `
      + `the ${TEN_THOUSAND_WARM_BUDGET_MS} ms budget.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
