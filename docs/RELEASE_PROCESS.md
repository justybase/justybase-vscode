# Release Process

Use GitHub Actions for every new version. The process has two phases:

1. `Prepare Release` bumps the synchronized versions and opens a pull request.
2. `Release` tags the merge commit after CI is green and publishes the selected
   extensions to both registries.

Do not create release tags manually and do not use `npm version patch` directly
for production releases.

## Why the process has two phases

The release commit used to be created inside the `Release` workflow with
`[skip ci]`, so CI never validated that exact commit and the publish workflow
had to re-run lint, type checks, unit tests, and integration tests. That
duplicated work and added several minutes to every release.

The current process tags a commit that already passed CI. The version bump is a
normal pull request, which means:

- CI validates the exact code that is released;
- `Release` does not repeat the quality, unit, or integration gates;
- the tagged commit and the published VSIX files come from the same tree that
  was reviewed and merged.

## Quick start

### 1. Push and verify the code change

```bash
git checkout master
git pull origin master

git add .
git commit -m "feat: new feature"
git push origin master
```

Wait for the required CI checks on that commit.

### 2. Prepare the release

Go to GitHub → Actions → `Prepare Release` → `Run workflow` and select:

- `release_type`: `patch`, `minor`, `major`, a prerelease increment, or `exact`;
- `version` only for `release_type=exact` (for example `3.21.0`);
- `target_branch`, normally `master`.

The workflow bumps the core extension, `@justybase/contracts`, every managed
companion extension, and the documentation version markers. It pushes the
`release/v<version>` branch and opens (or updates) a pull request titled
`chore(release): v<version>`.

Re-running `Prepare Release` force-pushes that automation branch and updates
the open pull request. Do not edit version files by hand on the branch.

### 3. Merge after CI

Wait for CI on the release pull request to pass, review the diff, and merge it.
Branch protection should require the CI checks before merge.

### 4. Tag and publish

Go to GitHub → Actions → `Release` → `Run workflow` and select:

- `release_type=current` (the version already committed on the target branch);
- `prerelease` when the GitHub Release should be marked as a pre-release;
- `target_branch`, normally `master`;
- the extensions to publish (`core`, DB2, DuckDB, Oracle, PostgreSQL, Vertica,
  MS SQL Server, MySQL, Snowflake, and/or Access).

There is no draft mode. The workflow creates a published GitHub Release and
publishes the selected extensions to both registries.

## What each workflow does

`Prepare Release`:

- validates the requested increment and rejects an already-existing tag;
- synchronizes versions in the core extension and managed companion extensions;
- updates tracked documentation version markers;
- commits the changes to `release/v<version>` and opens or updates the pull
  request;
- dispatches the `CI` workflow on the release branch. A pull request created
  with `GITHUB_TOKEN` does not trigger `pull_request` workflows, so the release
  phase dispatches CI explicitly to keep the pull request covered by the full
  quality, unit, and integration gates.

`Release`:

- checks out the target branch (or an existing tag for `release_type=specific`);
- validates that every package version matches `v<version>`;
- confirms the target commit has a successful CI run (waiting up to 15 minutes
  for a queued or running run);
- creates and pushes the annotated tag;
- creates the GitHub Release;
- builds the selected VSIX files, audits them, attaches them to the release, and
  publishes them to the Visual Studio Code Marketplace and Open VSX.

`Publish Extensions` is the downstream workflow and can also be started
manually to rebuild or republish an existing tag.

## Trust model and the CI guard

`Release` runs `scripts/verify-release-ci.js` before creating the tag. The
script checks the GitHub Actions API for a successful `ci.yml` run on the exact
commit. If CI is still running it waits; if CI failed, it stops the release.

The publish workflow does not re-run the quality, unit, or integration gates.
It still validates the release metadata, builds and audits every selected VSIX,
and keeps the Db2 VS Code runtime smoke matrix in the release path.

For a manual `Publish Extensions` dispatch, `verify_ci` defaults to `true`, so
the tagged commit is checked again. Set it to `false` only to recover a tag
whose CI history has expired (GitHub retains workflow runs for 90 days by
default).

Legacy tags created before the two-phase process point at a
`chore: release <version> [skip ci]` commit whose parent passed CI. The
verification script accepts that shape only when every file in the release
commit is a version file or documentation marker, and only on the explicit
`--allow-version-only-parent` path used by manual republishing.

## Re-publishing and recovery

### CI failed on the release pull request

Fix the failure on `master`, wait for CI, and merge the fix into the release
branch (or re-run `Prepare Release`). Do not merge a red release pull request.

### Release stopped before tagging

The verification script either found a failed CI run or timed out waiting for
one. Inspect the CI run for the commit, fix or rerun it, then start `Release`
again. No tag or GitHub Release was created.

### Tag exists but publication failed

Use `Release` with `release_type=specific` and `existing_release_tag`, or run
`Publish Extensions` manually with the same tag. Publishing uses duplicate-safe
behavior, so a retry skips versions already accepted by a registry and
continues with missing packages.

If the tag exists but the GitHub Release was never created, create the release
for that tag first (or delete the tag and run `Release` again); the attach step
uploads assets to an existing GitHub Release.

Registry uploads are not transactional. If one registry succeeds and the other
fails, rerun the same tag after correcting the reported problem.

### The release pull request needs different targets

Publish targets are selected in `Release`, not in `Prepare Release`. Version
preparation is independent of which extensions are published.

## Version rules

- `Prepare Release` uses `scripts/version-sync.js`, which runs
  `npm version --no-git-tag-version` in the core and every managed extension.
- The version must be valid semver and newer than the current one;
  `version-sync.js check` validates semver and synchronization between
  `package.json`, `package-lock.json`, the shared contracts package, and the
  documentation markers. The registries reject a version that is not newer than
  the published one.
- `release_type=exact` is intended for planned versions such as `3.21.0` or
  `3.21.0-rc.1`. Use a normal increment for routine releases.
- Never publish a different VSIX manually to only one registry.

## One-time Open VSX setup

Before the first publication:

1. Sign the Open VSX Publisher Agreement.
2. Create the `krzysztof-d` namespace.
3. Claim/verify the namespace when possible.
4. Keep `OVSX_TOKEN` as a repository-level or organization-level GitHub Actions
   secret. Do not put it in source files or workflow logs.

The namespace must match the `publisher` field in the extension manifests.
The `OVSX_TOKEN` secret is mapped to the `OVSX_PAT` variable expected by the
Open VSX CLI.

## Troubleshooting

### Version mismatch

```bash
node scripts/version-sync.js check
```

Run `Prepare Release` again instead of editing version files manually.

### CI verification failed

```bash
node scripts/verify-release-ci.js --sha "$(git rev-parse HEAD)" --repo owner/name
```

The script prints the CI run URL and the conclusion it found. A common cause is
starting `Release` before CI on the merge commit has finished; the script waits
up to 15 minutes, then fails.

CI runs automatically for pushes and pull requests targeting `master` and
`main`. If `target_branch` is a different branch, dispatch `CI` manually for
that branch before starting `Release`.

### Release gate failure before tagging

The release workflow validates registry secrets and the synchronized versions
before it creates a tag. Fix the reported problem and start `Release` again.

### Open VSX authorization failure

Verify that:

- the Publisher Agreement was accepted;
- namespace `krzysztof-d` exists and is owned by the token holder;
- `OVSX_TOKEN` is available as a repository or organization secret;
- the token has not expired or been revoked.
