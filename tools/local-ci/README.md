# Local CI runner

Runs the repository's GitHub Actions quality, test, and release-dry-run phases
locally with Docker. It is a pre-flight and release-rehearsal tool, not a
replacement for required GitHub checks.

## Why not `act`?

`act` can execute parts of a workflow YAML, but this repository's release path
depends on reusable workflows, artifact upload/download, `GITHUB_TOKEN`,
`GITHUB_OUTPUT`, `gh release`, and marketplace secrets. The local runner instead
executes the same npm scripts and CLI tools the workflows execute, inside a
pinned Node 22 Linux container.

## How it works

```text
host checkout (read-only)          Docker named volumes
┌──────────────────────┐          ┌─────────────────────────────┐
│ /src                 │  rsync   │ /work   disposable snapshot │
│ tools/local-ci/*     │ ───────> │ /ci-state dependency hashes │
└──────────────────────┘          │ /ci-state/npm-cache         │
                                  └─────────────────────────────┘
                                               │
                                               ▼
                                  artifacts/local-ci/ (reports, VSIX)
```

- The host checkout is mounted **read-only** at `/src`.
- Every run incrementally syncs it into a disposable `/work` volume.
- `npm ci`, builds, coverage, and packaging only touch the snapshot, so
  Windows and Linux `node_modules` never mix and the source working tree is not
  modified.
- Dependency installation is cached by hashing `package-lock.json` and
  workspace manifests. Lockfile changes trigger `npm ci` automatically.
- The npm cache lives in `/ci-state/npm-cache` inside a named volume, so it is
  reused between runs and is owned by the container user.
- Use `--refresh-deps` to force a reinstall.

## Requirements

- WSL2 (or any Linux environment) with Docker Engine and a running daemon.
- About 15 GiB free for the image, snapshot, dependencies, and coverage output.
- Network access on the first run (apt packages, npm packages, the pinned
  Access reference clone, and the VS Code Extension Host download).
- Node.js is **not** required on the host; the container supplies Node 22.

## Quick start

```bash
# From the repository root, in WSL:
tools/local-ci/run.sh quality
tools/local-ci/run.sh tests
tools/local-ci/run.sh release-dry-run --release-type patch
tools/local-ci/run.sh all --release-type patch
```

The first invocation builds `justybase-local-ci:node22` and copies the working
tree into a Docker volume. Later runs reuse the image, npm cache, dependency
installations, and the VS Code download cache.

If the executable bit is missing in your checkout, run the same commands with a
`bash` prefix: `bash tools/local-ci/run.sh quality`.

Outputs are written to `artifacts/local-ci/` (already gitignored):

- `latest-<stage>.json` and `latest-<stage>.md` – machine- and human-readable
  step timings;
- `release-dry-run/<version>/<name>.vsix` – packaged extension;
- `release-dry-run/<version>/marketplace-review/` – audit report and
  `SHA256SUMS`;
- `release-dry-run/<version>/release-dry-run.json` – version, tag, VSIX hash,
  changed files, and explicit `published: false`, `pushed: false`,
  `tagged: false`.

## Stage mapping

| Local stage | GitHub Actions jobs |
|-------------|---------------------|
| `quality` | `docs` + `quality` |
| `tests` | `unit-tests`, `completion-parity`, `quickfix-regression`, `parser-perf`, `extension-host-result-panel` |
| `release-dry-run` | `prepare-release` (version resolution only) + `build-main` + `audit-vsix`, without commit/tag/push/publish |

`all` runs the three stages in order.

### `quality`

- `npm run docs:check`
- `npm run check:access-index-codes`
- `npm audit --omit=dev --audit-level=high`
- `npm run version:check`
- `npm run check-types`
- `npm run check:architecture`
- `npm run check-types:shared`
- conditional `check-types:<dialect>` for every extension with a lockfile
- `npm run lint`, `npm run lint:extended:check`
- `npm run test:quality-tools`
- `npm run build`

### `tests`

- `npm run build:access-file`
- `npm run test:coverage`
- `npm run test:coverage:ui`
- semantic-token latency without coverage
- `npm run test:completion-parity`
- `npm run test:quickfix-regression`
- `npm run test:parser-perf`
- `xvfb-run -a npm run test:extension-host`
- optional changed-coverage gate with `--base <git-ref>`

### `release-dry-run`

1. Refuses to run when the **source** checkout is dirty (unless
   `--allow-dirty`).
2. Bumps versions in the disposable snapshot with
   `node scripts/version-sync.js bump <type> --include-optionals`
   (or `set <version>` for `--release-type exact`).
3. Validates metadata with
   `node scripts/version-sync.js check --release-tag v<version> --include-optionals`.
4. Checks that the remote tag does not already exist.
5. Runs `npm run build`, packages the VSIX exactly like the release workflow,
   and runs `node scripts/audit-marketplace-vsix.js`. Packaging happens on
   Linux; the official GitHub release still builds the core VSIX on Windows, so
   the archive hash can differ even when the contents are equivalent.
6. Copies the VSIX and audit report to `artifacts/local-ci/`.

It never commits, tags, pushes, uploads release assets, or publishes to a
marketplace. The version bump exists only inside `/work` and is discarded on the
next sync.

## Options

| Option | Description |
|--------|-------------|
| `--release-type <type>` | `patch` (default), `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, or `exact` |
| `--version <x.y.z>` | Explicit version for `--release-type exact` |
| `--base <git-ref>` | Enable the changed high-risk coverage gate |
| `--allow-dirty` | Let `release-dry-run` proceed with uncommitted changes |
| `--refresh-deps` | Force `npm ci` even when cached hashes match |
| `--skip-deps` | Reuse installed dependencies and fail if they are missing |
| `--rebuild` | Rebuild the Docker image first |
| `--clean` | Remove this checkout's snapshot and state volumes first |

Examples:

```bash
tools/local-ci/run.sh release-dry-run --release-type exact --version 3.21.0
tools/local-ci/run.sh tests --base origin/master
tools/local-ci/run.sh --clean tests
```

## Stage 1 scope

Intentionally not covered yet:

- live database integrations (DuckDB/File SQL/Access are planned for Stage 2,
  and external Oracle/DB2/Snowflake/MSSQL/MySQL/ClickHouse/PostgreSQL/Vertica
  servers are out of scope);
- the Java Jackcess cross-check;
- the informational TypeScript 7 compatibility job;
- publishing to Visual Studio Marketplace or Open VSX, tagging, pushing, and
  GitHub Releases (Stage 3);
- Windows and macOS runner parity. By design every stage runs in the Linux
  container; the release dry run packages the VSIX with `vsce` on Linux. The
  GitHub workflow still builds the official package on Windows, so byte-for-byte
  hashes may differ, but the packaged contents and the marketplace audit are
  equivalent.

The pinned Access reference (`tools/access-ddl-compare/bootstrap.sh`) runs in
the disposable snapshot before the index-code check. The first run needs network
access; later runs reuse the clone stored in the snapshot volume. The host
checkout is never modified.

The Extension Host gate runs the deterministic SQLite scenario. The Netezza
Extension Host scenario requires `NZ_DEV_*` credentials and a reachable server,
so it remains a separate live test.

## Troubleshooting

**Docker socket permission denied**

```bash
sudo usermod -aG docker "$USER"
# log out and back in
```

**Stale dependencies after editing a manifest**

```bash
tools/local-ci/run.sh --clean quality
# or, cheaper:
tools/local-ci/run.sh quality --refresh-deps
```

**Image changes are not picked up**

```bash
tools/local-ci/run.sh --rebuild quality
```

**Out of disk space**

```bash
docker volume ls | grep justybase-local-ci
docker volume rm <volume> [<volume> ...]
```

**Low memory / Jest OOM**

The coverage suites use a 4 GiB Node heap. Give WSL at least 8 GiB in
`.wslconfig` or run the stages separately.

**Line endings**

Files under `tools/local-ci/` are forced to LF by `.gitattributes`; `run.sh`
must stay LF to work in WSL. If a Windows editor rewrites it, run
`git add --renormalize tools/local-ci` or `git checkout -- tools/local-ci`.

## Security notes

- No marketplace or GitHub tokens are required or read in Stage 1.
- The source checkout is mounted read-only; the runner does not write to it.
- The disposable snapshot contains any uncommitted changes from the host, so
  `release-dry-run` refuses to run unless the checkout is clean (or
  `--allow-dirty` is explicit).
- Container logs and summaries contain command names and timings, not
  credentials.
