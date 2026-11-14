import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  classifyRuns,
  isVersionOnlyFile,
  isVersionOnlyReleaseCommit,
  parseArgs,
} = require("./verify-release-ci.js");

test("isVersionOnlyFile accepts files written by version-sync", () => {
  const accepted = [
    "package.json",
    "package-lock.json",
    "packages/contracts/package.json",
    "extensions/db2/package.json",
    "extensions/db2/package-lock.json",
    "docs/guide/index.md",
  ];

  for (const filename of accepted) {
    assert.equal(isVersionOnlyFile(filename), true, filename);
  }
});

test("isVersionOnlyFile rejects executable or unrelated paths", () => {
  const rejected = [
    "src/extension.ts",
    "scripts/version-sync.js",
    "extensions/db2/src/extension.ts",
    "extensions/db2/README.md",
    "README.md",
    "docs/guide/version.json",
    ".github/workflows/release.yml",
    "",
  ];

  for (const filename of rejected) {
    assert.equal(isVersionOnlyFile(filename), false, filename);
  }
});

test("isVersionOnlyReleaseCommit detects legacy version-only release commits", () => {
  const commit = {
    commit: { message: "chore: release 3.20.8 [skip ci]\n" },
    files: [
      { filename: "package.json" },
      { filename: "extensions/db2/package.json" },
      { filename: "docs/guide/index.md" },
    ],
  };

  assert.equal(isVersionOnlyReleaseCommit(commit), true);
});

test("isVersionOnlyReleaseCommit rejects other commits", () => {
  assert.equal(
    isVersionOnlyReleaseCommit({
      commit: { message: "chore: release 3.20.8 [skip ci]" },
      files: [{ filename: "src/extension.ts" }],
    }),
    false,
  );

  assert.equal(
    isVersionOnlyReleaseCommit({
      commit: { message: "feat: add a feature" },
      files: [{ filename: "package.json" }],
    }),
    false,
  );

  assert.equal(
    isVersionOnlyReleaseCommit({
      commit: { message: "chore: release 3.20.8 [skip ci]" },
      files: [],
    }),
    false,
  );
});

test("classifyRuns prefers a successful run over older failures", () => {
  const success = { status: "completed", conclusion: "success", html_url: "ok" };
  const failed = { status: "completed", conclusion: "failure", html_url: "bad" };

  assert.deepEqual(classifyRuns([failed, success]), { state: "success", run: success });
  assert.deepEqual(classifyRuns([success, failed]), { state: "success", run: success });
});

test("classifyRuns reports pending, failed, and absent runs", () => {
  const pending = { status: "in_progress", conclusion: null };
  const failed = { status: "completed", conclusion: "failure" };

  assert.deepEqual(classifyRuns([pending]), { state: "pending", run: pending });
  assert.deepEqual(classifyRuns([failed]), { state: "failed", run: failed });
  assert.deepEqual(classifyRuns([]), { state: "none" });
  assert.deepEqual(classifyRuns(undefined), { state: "none" });
});

test("parseArgs parses the documented flags", () => {
  const options = parseArgs([
    "--sha",
    "abc123",
    "--repo",
    "owner/name",
    "--workflow",
    "ci.yml",
    "--wait-seconds",
    "60",
    "--allow-version-only-parent",
  ]);

  assert.equal(options.sha, "abc123");
  assert.equal(options.repo, "owner/name");
  assert.equal(options.workflow, "ci.yml");
  assert.equal(options.waitSeconds, 60);
  assert.equal(options.allowVersionOnlyParent, true);
  assert.equal(options.help, false);
});

test("parseArgs rejects missing values and unknown flags", () => {
  assert.throws(() => parseArgs(["--sha"]), /Missing value for --sha/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/);
  assert.throws(
    () => parseArgs(["--sha", "abc", "--wait-seconds", "-1"]),
    /Invalid --wait-seconds/,
  );
});
