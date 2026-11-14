import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  classifyRuns,
  collectTreeEquivalentCandidates,
  findTreeEquivalentGreenCommit,
  isVersionOnlyFile,
  isVersionOnlyReleaseCommit,
  parseArgs,
} = require("./verify-release-ci.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetchMock({ commits, pulls = {}, runs = {} }) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const parts = url.pathname.split("/");

    if (parts[4] === "commits" && parts[6] === "pulls") {
      return jsonResponse(pulls[parts[5]] ?? []);
    }

    if (parts[4] === "commits") {
      const commit = commits[parts[5]];
      return commit ? jsonResponse(commit) : jsonResponse({ message: "Not Found" }, 404);
    }

    if (url.pathname.includes("/actions/workflows/") && url.pathname.endsWith("/runs")) {
      return jsonResponse({ workflow_runs: runs[url.searchParams.get("head_sha")] ?? [] });
    }

    return jsonResponse({ message: `unexpected ${url.pathname}` }, 404);
  };
}

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
    "--allow-tree-equivalent",
  ]);

  assert.equal(options.sha, "abc123");
  assert.equal(options.repo, "owner/name");
  assert.equal(options.workflow, "ci.yml");
  assert.equal(options.waitSeconds, 60);
  assert.equal(options.allowVersionOnlyParent, true);
  assert.equal(options.allowTreeEquivalent, true);
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

test("collectTreeEquivalentCandidates uses parents and pull request heads", () => {
  const commit = {
    commit: { tree: { sha: "tree" } },
    parents: [{ sha: "base" }, { sha: "merge-parent" }],
  };
  const pulls = [{ head: { sha: "pr-head" } }];

  assert.deepEqual(
    collectTreeEquivalentCandidates(commit, pulls).sort(),
    ["base", "merge-parent", "pr-head"],
  );
});

test("collectTreeEquivalentCandidates ignores commits without a tree", () => {
  assert.deepEqual(collectTreeEquivalentCandidates({}, []), []);
  assert.deepEqual(collectTreeEquivalentCandidates({ commit: {} }, []), []);
});

test("findTreeEquivalentGreenCommit accepts a green merge parent with the same tree", async () => {
  const originalFetch = globalThis.fetch;
  try {
    installFetchMock({
      commits: {
        merge: { commit: { tree: { sha: "T" } }, parents: [{ sha: "base" }, { sha: "head" }] },
        base: { commit: { tree: { sha: "B" } }, parents: [] },
        head: { commit: { tree: { sha: "T" } }, parents: [] },
      },
      runs: { head: [{ status: "completed", conclusion: "success", html_url: "run" }] },
    });

    const result = await findTreeEquivalentGreenCommit({
      repo: "o/r",
      workflow: "ci.yml",
      sha: "merge",
      token: "token",
      commit: {
        commit: { tree: { sha: "T" } },
        parents: [{ sha: "base" }, { sha: "head" }],
      },
    });

    assert.equal(result?.sha, "head");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findTreeEquivalentGreenCommit accepts a green pull request head after a squash merge", async () => {
  const originalFetch = globalThis.fetch;
  try {
    installFetchMock({
      commits: {
        squash: { commit: { tree: { sha: "T" } }, parents: [{ sha: "base" }] },
        base: { commit: { tree: { sha: "B" } }, parents: [] },
        "pr-head": { commit: { tree: { sha: "T" } }, parents: [] },
      },
      pulls: { squash: [{ head: { sha: "pr-head" } }] },
      runs: { "pr-head": [{ status: "completed", conclusion: "success" }] },
    });

    const result = await findTreeEquivalentGreenCommit({
      repo: "o/r",
      workflow: "ci.yml",
      sha: "squash",
      token: "token",
      commit: {
        commit: { tree: { sha: "T" } },
        parents: [{ sha: "base" }],
      },
    });

    assert.equal(result?.sha, "pr-head");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findTreeEquivalentGreenCommit rejects a different tree", async () => {
  const originalFetch = globalThis.fetch;
  try {
    installFetchMock({
      commits: {
        merge: { commit: { tree: { sha: "T" } }, parents: [{ sha: "head" }] },
        head: { commit: { tree: { sha: "OTHER" } }, parents: [] },
      },
      runs: { head: [{ status: "completed", conclusion: "success" }] },
    });

    const result = await findTreeEquivalentGreenCommit({
      repo: "o/r",
      workflow: "ci.yml",
      sha: "merge",
      token: "token",
      commit: { commit: { tree: { sha: "T" } }, parents: [{ sha: "head" }] },
    });

    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findTreeEquivalentGreenCommit rejects a same-tree candidate with failed CI", async () => {
  const originalFetch = globalThis.fetch;
  try {
    installFetchMock({
      commits: {
        merge: { commit: { tree: { sha: "T" } }, parents: [{ sha: "head" }] },
        head: { commit: { tree: { sha: "T" } }, parents: [] },
      },
      runs: { head: [{ status: "completed", conclusion: "failure" }] },
    });

    const result = await findTreeEquivalentGreenCommit({
      repo: "o/r",
      workflow: "ci.yml",
      sha: "merge",
      token: "token",
      commit: { commit: { tree: { sha: "T" } }, parents: [{ sha: "head" }] },
    });

    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
