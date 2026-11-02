/**
 * JOIN ranking replay benchmark (leave-one-file-out Top-1/Top-3/Top-5/MRR).
 *
 * Without configuration it replays the labelled synthetic corpus. Point it at a
 * real SQL tree to measure suggestion quality on your own workspace:
 *
 *   JOIN_REPLAY_DIR=/path/to/sql npm run benchmark:join-ranking
 *
 * Optional: JOIN_REPLAY_DATABASE / JOIN_REPLAY_SCHEMA (effective scope),
 * JOIN_REPLAY_MAX_FILES (default 2,000). The report is written to
 * `Benchmark/joinRankingReplay.results.md` (gitignored); it contains file paths,
 * table names and counters only, never SQL text.
 */

jest.unmock("chevrotain");

import * as fs from "fs";
import * as path from "path";
import {
  formatJoinRankingReplayReport,
  runJoinRankingReplay,
  type ReplayFile,
} from "../src/knowledge/joinRankingReplay";
import {
  buildJoinRankingCorpus,
  JOIN_RANKING_CORPUS_NOW,
} from "../src/__tests__/knowledge/fixtures/joinRankingCorpus";

function collectSqlFiles(root: string, limit: number): ReplayFile[] {
  const files: ReplayFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= limit) {
        return;
      }
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        const stat = fs.statSync(absolute);
        if (stat.size > 2 * 1024 * 1024) {
          continue;
        }
        files.push({
          relPath: path.relative(root, absolute).split(path.sep).join("/"),
          text: fs.readFileSync(absolute, "utf8"),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  visit(root);
  return files;
}

describe("JOIN ranking replay benchmark", () => {
  it("reports leave-one-file-out ranking quality", async () => {
    const directory = process.env.JOIN_REPLAY_DIR;
    const files = directory
      ? collectSqlFiles(path.resolve(directory), Number(process.env.JOIN_REPLAY_MAX_FILES ?? 2000))
      : buildJoinRankingCorpus();
    const report = await runJoinRankingReplay(files, {
      databaseKind: "netezza",
      effectiveDatabase: process.env.JOIN_REPLAY_DATABASE ?? (directory ? undefined : "DWH"),
      effectiveSchema: process.env.JOIN_REPLAY_SCHEMA ?? (directory ? undefined : "ADMIN"),
      now: directory ? new Date().toISOString() : JOIN_RANKING_CORPUS_NOW,
    });
    const title = directory
      ? `JOIN ranking replay — ${files.length} file(s) from JOIN_REPLAY_DIR`
      : "JOIN ranking replay — labelled synthetic corpus";
    fs.writeFileSync(
      path.join(__dirname, "joinRankingReplay.results.md"),
      formatJoinRankingReplayReport(report, title),
    );
    expect(report.files).toBe(files.length);
  });
});
