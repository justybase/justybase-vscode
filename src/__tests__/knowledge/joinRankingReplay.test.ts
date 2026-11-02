jest.unmock("chevrotain");

import { writeFileSync } from "fs";
import {
  formatJoinRankingReplayReport,
  runGroupByGhostReplay,
  runJoinRankingReplay,
  runNewLineJoinGhostReplay,
  summarizeJoinGhost,
  summarizeKeystrokes,
} from "../../knowledge/joinRankingReplay";
import { detectGroupByGhost } from "../../server/groupByGhost";
import {
  buildJoinRankingCorpus,
  JOIN_RANKING_CORPUS_NOW,
} from "./fixtures/joinRankingCorpus";
import { CatalogReplayMetadataProvider } from "../../knowledge/replayCatalog";
import { buildLiveStarCatalog } from "./fixtures/liveStarCatalog";
import { LIVE_STAR_CORPUS, LIVE_STAR_CORPUS_NOW } from "./fixtures/liveStarCorpus";

describe("JOIN ranking replay (leave-one-file-out)", () => {
  it("measures Top-1/Top-5/MRR on the labelled corpus", async () => {
    const report = await runJoinRankingReplay(buildJoinRankingCorpus(), {
      databaseKind: "netezza",
      effectiveDatabase: "DWH",
      effectiveSchema: "ADMIN",
      now: JOIN_RANKING_CORPUS_NOW,
    });
    if (process.env.JOIN_REPLAY_REPORT) {
      writeFileSync(process.env.JOIN_REPLAY_REPORT, formatJoinRankingReplayReport(report));
    }

    expect(report.files).toBe(25);
    expect(report.cases).toBe(34);
    expect(report.covered).toBe(32);
    // Alphabetical within-tier order measured Top-1 6/34, Top-3 23/34 and
    // MRR 0.451 on this corpus; the scored order must not regress below the
    // calibrated values recorded in docs/join-knowledge/08-stage-2-calibration.md.
    expect(report.top1).toBeGreaterThanOrEqual(19);
    expect(report.top3).toBeGreaterThanOrEqual(32);
    expect(report.mrr).toBeGreaterThanOrEqual(0.73);
    expect(report.tieAwareMrr).toBeGreaterThanOrEqual(0.73);
  });

  it("ghosts ON conditions only when they are unambiguous", async () => {
    const report = await runJoinRankingReplay(buildJoinRankingCorpus(), {
      databaseKind: "netezza",
      effectiveDatabase: "DWH",
      effectiveSchema: "ADMIN",
      now: JOIN_RANKING_CORPUS_NOW,
      mode: "predicate",
    });
    // Measured 32/32 shown ghosts correct, 94% of all positions.
    const ghost = summarizeJoinGhost(report.details, "predicate");
    expect(ghost.precision).toBeGreaterThanOrEqual(0.95);
    expect(ghost.coverage).toBeGreaterThanOrEqual(0.9);
  });
});

describe("saved keystrokes over the star corpus", () => {
  it("measures every completion position in one unit", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const base = {
      databaseKind: "netezza" as const,
      effectiveDatabase: "JUST_DATA",
      effectiveSchema: "ADMIN",
      now: LIVE_STAR_CORPUS_NOW,
      metadataProvider,
    };
    const runs = (mode: "column" | "object", typed: number[], evidence: "none" | "workspace") => Promise.all(
      typed.map(async (count) => ({
        typed: count,
        report: await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence, mode, typed: count }),
      })),
    );
    const single = async (mode: "target" | "predicate") => summarizeKeystrokes(
      [{ typed: 0, report: await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, evidence: "none", mode }) }],
      { ghost: mode },
    );
    // Baseline 2026-10-27 (docs/join-knowledge/11-column-object-ranking.md): columns 0.838,
    // FROM 0.423 cold / 0.643 with workspace usage, JOIN targets 0.782, ON conditions 0.951.
    expect(summarizeKeystrokes(await runs("column", [0, 1, 2, 3], "none")).savedRatio).toBeGreaterThanOrEqual(0.83);
    expect(summarizeKeystrokes(await runs("object", [1, 2, 3], "none")).savedRatio).toBeGreaterThanOrEqual(0.41);
    expect(summarizeKeystrokes(await runs("object", [1, 2, 3], "workspace")).savedRatio).toBeGreaterThanOrEqual(0.63);
    expect((await single("target")).savedRatio).toBeGreaterThanOrEqual(0.77);
    expect((await single("predicate")).savedRatio).toBeGreaterThanOrEqual(0.94);
  });

  it("takes the cheapest of typing, choosing from the list and a ghost", () => {
    const report = (rank: number | undefined, leaders?: [string, string | undefined]) => ({
      files: 1, cases: 1, covered: 1, top1: 0, top3: 0, top5: 0, mrr: 0, tieAwareMrr: 0, tiers: {},
      details: [{ relPath: "a.sql", expected: "SALESAMOUNT", rank, candidates: 9, top: [], ...(leaders ? { leaders } : {}) }],
    });
    // 11 characters: rank 4 at no typing (4), rank 1 after two characters (3).
    expect(summarizeKeystrokes([{ typed: 0, report: report(4) }, { typed: 2, report: report(1) }]))
      .toEqual({ cases: 1, withoutCompletion: 11, withCompletion: 3, savedRatio: 1 - 3 / 11 });
    // Not offered: the whole name is typed.
    expect(summarizeKeystrokes([{ typed: 0, report: report(undefined) }]).withCompletion).toBe(11);
    // A confident correct ghost is one Tab.
    expect(summarizeKeystrokes([{ typed: 0, report: report(1, ["0_4_10_X", "2_10_Y"]) }], { ghost: "target" })
      .withCompletion).toBe(1);
  });
});

describe("GROUP BY ghost replay", () => {
  it("offers exactly the list the author wrote", () => {
    // Measured 2026-10-27: 30/30 (star) and 4/4 (labelled) shown, all exact.
    const star = runGroupByGhostReplay(LIVE_STAR_CORPUS, detectGroupByGhost);
    const labelled = runGroupByGhostReplay(buildJoinRankingCorpus(), detectGroupByGhost);
    expect(star).toMatchObject({ positions: 30, shown: 30, exact: 30 });
    expect(labelled).toMatchObject({ positions: 4, shown: 4, exact: 4 });
  });
});

describe("JOIN ranking replay with worksheet evidence", () => {
  it("indexes only the statements before the evaluated one in the same file", async () => {
    const worksheet = {
      relPath: "worksheet/1.sql",
      mtimeMs: Date.parse(JOIN_RANKING_CORPUS_NOW),
      text: [
        "SELECT * FROM MIS_FACT_SALES",
        "SELECT COUNT(*) FROM MIS_FACT_SALES WHERE 1 = 1",
        "SELECT MAX(1) FROM MIS_FACT_SALES",
        "SELECT * FROM MIS_FACT_SALES S",
      ].join(";\n"),
    };
    const metadataProvider = new CatalogReplayMetadataProvider({
      database: "DWH",
      defaultSchema: "ADMIN",
      tables: ["MIS_FACT_ARCHIVE", "MIS_FACT_SALES"].map((name) => ({
        schema: "ADMIN",
        name,
        columns: [{ name: "ID" }],
      })),
    }, "netezza");
    const base = {
      databaseKind: "netezza" as const,
      effectiveDatabase: "DWH",
      effectiveSchema: "ADMIN",
      now: JOIN_RANKING_CORPUS_NOW,
      metadataProvider,
      mode: "object" as const,
      typed: 1,
      evidence: "none" as const,
    };
    const without = await runJoinRankingReplay([worksheet], base);
    const withWorksheet = await runJoinRankingReplay([worksheet], { ...base, documentEvidence: true });

    expect(without.details.map((entry) => entry.rank)).toEqual([2, 2, 2, 2]);
    // Only the fourth statement follows three distinct earlier queries.
    expect(withWorksheet.details.map((entry) => entry.rank)).toEqual([2, 2, 2, 1]);
  });
});

describe("JOIN ranking replay over the star-schema catalog snapshot", () => {
  const base = {
    databaseKind: "netezza" as const,
    effectiveDatabase: "JUST_DATA",
    effectiveSchema: "ADMIN",
    now: LIVE_STAR_CORPUS_NOW,
  };

  it("ranks catalog-only targets for keyed and key-less star schemas", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const cold = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, metadataProvider, evidence: "none" });
    const combined = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, metadataProvider });
    const workspace = await runJoinRankingReplay(LIVE_STAR_CORPUS, base);
    if (process.env.JOIN_REPLAY_REPORT) {
      writeFileSync(`${process.env.JOIN_REPLAY_REPORT}.star.md`, [
        formatJoinRankingReplayReport(cold, "Star catalog snapshot, cold start", 100),
        formatJoinRankingReplayReport(combined, "Star catalog snapshot + workspace evidence", 100),
      ].join("\n"));
    }
    expect(cold.cases).toBe(71);
    expect(workspace.cases).toBe(71);
    // Before self-named keys, role-playing keys and the grain factor the cold
    // start offered 38/71 targets (AdventureWorks 7/40) at a tie-averaged MRR
    // of 0.29; see docs/join-knowledge/09-live-catalog-replay.md.
    expect(cold.covered).toBe(71);
    expect(cold.top1).toBeGreaterThanOrEqual(33);
    expect(cold.top3).toBeGreaterThanOrEqual(52);
    expect(cold.tieAwareMrr).toBeGreaterThanOrEqual(0.6);
    expect(combined.covered).toBe(71);
    expect(combined.tieAwareMrr).toBeGreaterThanOrEqual(0.56);
    expect(combined.tieAwareMrr).toBeGreaterThan(workspace.tieAwareMrr);
  });

  it("ranks ON conditions including role-playing keys", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const predicate = { ...base, mode: "predicate" as const, metadataProvider };
    const cold = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...predicate, evidence: "none" });
    const combined = await runJoinRankingReplay(LIVE_STAR_CORPUS, predicate);
    if (process.env.JOIN_REPLAY_REPORT) {
      writeFileSync(`${process.env.JOIN_REPLAY_REPORT}.on.md`, [
        formatJoinRankingReplayReport(cold, "ON conditions, cold start", 100),
        formatJoinRankingReplayReport(combined, "ON conditions + workspace evidence", 100),
      ].join("\n"));
    }
    expect(cold.cases).toBe(71);
    // Without self-named/role-playing keys: 64/71 covered, tie-averaged MRR 0.90;
    // the six `FACT.ORDERDATEKEY = DIMDATE.DATEKEY` conditions were never offered.
    expect(cold.covered).toBe(71);
    expect(cold.top1).toBeGreaterThanOrEqual(63);
    expect(cold.tieAwareMrr).toBeGreaterThanOrEqual(0.94);
    expect(combined.covered).toBe(71);
    expect(combined.top1).toBeGreaterThanOrEqual(67);
    expect(combined.tieAwareMrr).toBeGreaterThanOrEqual(0.96);

    // Ghost text: measured 57/57 (cold) and 61/62 (combined) correct when shown.
    const coldGhost = summarizeJoinGhost(cold.details, "predicate");
    const combinedGhost = summarizeJoinGhost(combined.details, "predicate");
    expect(coldGhost.precision).toBeGreaterThanOrEqual(0.95);
    expect(coldGhost.coverage).toBeGreaterThanOrEqual(0.75);
    expect(combinedGhost.precision).toBeGreaterThanOrEqual(0.95);
    expect(combinedGhost.coverage).toBeGreaterThanOrEqual(0.8);
  });

  it("ranks columns after a table qualifier", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const column = { ...base, metadataProvider, mode: "column" as const };
    const cold = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...column, evidence: "none" });
    const learned = await runJoinRankingReplay(LIVE_STAR_CORPUS, column);
    const learnedTyped = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...column, typed: 1 });
    // Baseline 2026-10-27 (docs/join-knowledge/11-column-object-ranking.md):
    // tie-averaged MRR 0.312 catalog order, 0.456 with usage bands, 0.745 after one
    // character; with the clause prior 0.499, 0.549 and 0.822. Including the 24
    // SUM(/AVG( arguments (no types in this snapshot): 0.490, 0.561, 0.827.
    expect(cold.cases).toBe(306);
    expect(cold.covered).toBe(306);
    expect(cold.details.filter((entry) => entry.clause === "aggregate")).toHaveLength(24);
    expect(cold.tieAwareMrr).toBeGreaterThanOrEqual(0.48);
    expect(learned.tieAwareMrr).toBeGreaterThanOrEqual(0.55);
    expect(learnedTyped.tieAwareMrr).toBeGreaterThanOrEqual(0.82);
  });

  it("ranks FROM sources by breadth of use", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const report = await runJoinRankingReplay(LIVE_STAR_CORPUS, {
      ...base, metadataProvider, mode: "object", typed: 1,
    });
    // A linear object breadth saturated at 4 files: Top-1 0/40, MRR 0.236; log
    // breadth 9/40, 0.356; JOIN targets no longer counted as FROM usage 14/40, 0.490.
    expect(report.cases).toBe(40);
    expect(report.covered).toBe(40);
    expect(report.top1).toBeGreaterThanOrEqual(14);
    expect(report.mrr).toBeGreaterThanOrEqual(0.48);
  });

  it("never ghosts a target from catalog or thin workspace evidence", async () => {
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const combined = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...base, metadataProvider });
    // The best score-based gate reached only 0.50 precision here (0.70 on the
    // labelled corpus): the next star-schema target is ambiguous.
    expect(summarizeJoinGhost(combined.details, "target").shown).toBe(0);
  });

  it("never ghosts a target or a new-line JOIN from executed evidence", async () => {
    // Every other file counts as one execution on its own day (execution
    // learning is on by default). With executed `0_4_` targets in the gate the
    // star corpus showed 3 target and 5 new-line ghosts, none correct.
    const metadataProvider = new CatalogReplayMetadataProvider(buildLiveStarCatalog(), "netezza");
    const executed = { ...base, metadataProvider, evidence: "executed" as const };
    const target = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...executed, mode: "target" });
    expect(target.tiers["0_4"]).toBeGreaterThan(0);
    expect(summarizeJoinGhost(target.details, "target").shown).toBe(0);

    const newLine = await runNewLineJoinGhostReplay(LIVE_STAR_CORPUS, executed);
    expect(newLine).toMatchObject({ positions: 111, joinPositions: 71, shown: 0 });

    const predicate = await runJoinRankingReplay(LIVE_STAR_CORPUS, { ...executed, mode: "predicate" });
    const predicateGhost = summarizeJoinGhost(predicate.details, "predicate");
    expect(predicateGhost.precision).toBeGreaterThanOrEqual(0.95);
    expect(predicateGhost.coverage).toBeGreaterThanOrEqual(0.8);
  });
});
