#!/usr/bin/env node
"use strict";

/**
 * Verifies that a commit already passed the repository CI workflow before it is
 * tagged or published.
 *
 * Release flow: `Prepare Release` opens a version-bump pull request, CI runs on
 * that pull request, the pull request is merged, and only then does `Release`
 * tag the merge commit. This script is the guard that prevents tagging or
 * publishing a commit whose CI did not finish successfully.
 *
 * Usage:
 *   node scripts/verify-release-ci.js --sha <sha> [options]
 *
 * Options:
 *   --sha <sha>                    Commit to verify (required).
 *   --repo <owner/name>            Repository (default: GITHUB_REPOSITORY).
 *   --workflow <file>              Workflow file to inspect (default: ci.yml).
 *   --wait-seconds <seconds>       How long to wait for a queued/running CI run
 *                                  (default: 900).
 *   --allow-version-only-parent    Accept a version-only release commit whose
 *                                  parent passed CI. Needed only for tags
 *                                  created before the release-PR flow, when the
 *                                  bump commit itself carried [skip ci].
 *   --help                         Print this help.
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage/configuration error.
 *
 * The GitHub token is read from GITHUB_TOKEN or GH_TOKEN and only needs
 * `actions: read` and `contents: read`.
 */

const { setTimeout: sleep } = require("node:timers/promises");

const DEFAULT_WORKFLOW = "ci.yml";
const DEFAULT_WAIT_SECONDS = 900;
const POLL_INTERVAL_MS = 20_000;
const NO_RUN_GRACE_MS = 120_000;

const VERSION_ONLY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "packages/contracts/package.json",
]);

/**
 * Returns true when a path is only ever touched by `scripts/version-sync.js`.
 * Keep this list tight: a release commit (or a legacy `chore: release` commit)
 * must not contain executable changes.
 */
function isVersionOnlyFile(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    return false;
  }
  if (VERSION_ONLY_FILES.has(filename)) {
    return true;
  }
  if (/^extensions\/[^/]+\/package(-lock)?\.json$/.test(filename)) {
    return true;
  }
  return /^docs\/.+\.md$/.test(filename);
}

/**
 * Returns true for the legacy release commits created before the release-PR
 * flow: `chore: release <version> [skip ci]` that only changed version files.
 */
function isVersionOnlyReleaseCommit(commit) {
  const message = String(commit?.commit?.message ?? "")
    .split("\n")[0]
    .trim();
  if (!/^chore: release \S+ \[skip ci\]$/.test(message)) {
    return false;
  }
  const files = Array.isArray(commit?.files) ? commit.files : [];
  return files.length > 0 && files.every((file) => isVersionOnlyFile(file.filename));
}

/**
 * Classifies the CI runs returned for one commit. A successful run always wins
 * over a pending retry; a completed run without success is a failure.
 */
function classifyRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const success = list.find(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
  if (success) {
    return { state: "success", run: success };
  }
  const pending = list.find((run) => run.status !== "completed");
  if (pending) {
    return { state: "pending", run: pending };
  }
  const failed = list.find((run) => run.status === "completed");
  if (failed) {
    return { state: "failed", run: failed };
  }
  return { state: "none" };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    sha: "",
    repo: process.env.GITHUB_REPOSITORY || "",
    workflow: DEFAULT_WORKFLOW,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    allowVersionOnlyParent: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--sha":
        options.sha = requireValue(argv, (index += 1), argument);
        break;
      case "--repo":
        options.repo = requireValue(argv, (index += 1), argument);
        break;
      case "--workflow":
        options.workflow = requireValue(argv, (index += 1), argument);
        break;
      case "--wait-seconds": {
        const raw = requireValue(argv, (index += 1), argument);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid --wait-seconds value: ${raw}`);
        }
        options.waitSeconds = parsed;
        break;
      }
      case "--allow-version-only-parent":
        options.allowVersionOnlyParent = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/verify-release-ci.js --sha <sha> [options]",
      "",
      "Options:",
      "  --repo <owner/name>            Defaults to GITHUB_REPOSITORY.",
      "  --workflow <file>              Defaults to ci.yml.",
      "  --wait-seconds <seconds>       Defaults to 900.",
      "  --allow-version-only-parent    Accept a legacy version-only release commit",
      "                                 whose parent passed CI.",
      "  --help                         Show this help.",
      "",
    ].join("\n"),
  );
}

async function githubRequest(pathname, token) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "justybase-release-ci-verifier",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub API ${pathname} returned ${response.status} ${response.statusText}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
    );
  }

  return response.json();
}

async function listWorkflowRuns({ repo, workflow, sha, token }) {
  const query = new URLSearchParams({
    head_sha: sha,
    per_page: "100",
  });
  const payload = await githubRequest(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query.toString()}`,
    token,
  );
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

async function getCommit({ repo, sha, token }) {
  return githubRequest(`/repos/${repo}/commits/${sha}`, token);
}

async function resolveCommitSha({ repo, sha, token }) {
  if (/^[0-9a-f]{40}$/i.test(sha)) {
    return sha;
  }
  const commit = await getCommit({ repo, sha, token });
  return commit.sha;
}

function describeRun(run) {
  if (!run) {
    return "no run";
  }
  return `${run.status}/${run.conclusion ?? "pending"}${run.html_url ? ` (${run.html_url})` : ""}`;
}

async function verifySha({ repo, workflow, sha, token, deadline, allowVersionOnlyParent }) {
  let checkedSha = await resolveCommitSha({ repo, sha, token });
  let checkedParent = false;

  while (true) {
    const runs = await listWorkflowRuns({ repo, workflow, sha: checkedSha, token });
    const outcome = classifyRuns(runs);

    if (outcome.state === "success") {
      process.stdout.write(
        `CI verified for ${checkedSha}${checkedParent ? " (parent of a version-only release commit)" : ""}: ${describeRun(outcome.run)}\n`,
      );
      return true;
    }

    if (outcome.state === "failed") {
      if (allowVersionOnlyParent && !checkedParent) {
        const commit = await getCommit({ repo, sha: checkedSha, token });
        const parentSha = commit?.parents?.[0]?.sha;
        if (parentSha && isVersionOnlyReleaseCommit(commit)) {
          process.stdout.write(
            `No CI for version-only release commit ${checkedSha}; checking parent ${parentSha}.\n`,
          );
          checkedSha = parentSha;
          checkedParent = true;
          continue;
        }
      }
      process.stderr.write(
        `CI for ${checkedSha} did not pass: ${describeRun(outcome.run)}\n`,
      );
      return false;
    }

    if (outcome.state === "none") {
      if (allowVersionOnlyParent && !checkedParent) {
        const commit = await getCommit({ repo, sha: checkedSha, token });
        const parentSha = commit?.parents?.[0]?.sha;
        if (parentSha && isVersionOnlyReleaseCommit(commit)) {
          process.stdout.write(
            `No CI for version-only release commit ${checkedSha}; checking parent ${parentSha}.\n`,
          );
          checkedSha = parentSha;
          checkedParent = true;
          continue;
        }
      }

      const commit = await getCommit({ repo, sha: checkedSha, token });
      const committedAt = Date.parse(commit?.commit?.committer?.date ?? "");
      if (Number.isFinite(committedAt) && Date.now() - committedAt > NO_RUN_GRACE_MS) {
        process.stderr.write(
          `No CI run was found for ${checkedSha} and the commit is older than ${
            NO_RUN_GRACE_MS / 1000
          }s. Push a tested commit or run CI manually before releasing.\n`,
        );
        return false;
      }
    } else {
      process.stdout.write(
        `CI for ${checkedSha} is still running: ${describeRun(outcome.run)}. Waiting...\n`,
      );
    }

    if (Date.now() >= deadline) {
      process.stderr.write(
        `Timed out waiting for CI on ${checkedSha}. Wait for the CI run to finish and re-run the release.\n`,
      );
      return false;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n`);
    printUsage();
    return 2;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  if (!options.sha) {
    process.stderr.write("Missing required --sha argument.\n\n");
    printUsage();
    return 2;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    process.stderr.write(
      "Missing repository. Pass --repo owner/name or set GITHUB_REPOSITORY.\n",
    );
    return 2;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    process.stderr.write("Missing GITHUB_TOKEN or GH_TOKEN.\n");
    return 2;
  }

  const deadline = Date.now() + options.waitSeconds * 1000;

  try {
    const verified = await verifySha({
      repo: options.repo,
      workflow: options.workflow,
      sha: options.sha,
      token,
      deadline,
      allowVersionOnlyParent: options.allowVersionOnlyParent,
    });
    return verified ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Release CI verification failed: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  classifyRuns,
  isVersionOnlyFile,
  isVersionOnlyReleaseCommit,
  parseArgs,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
