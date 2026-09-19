# Release Process

Use the GitHub Actions workflow named `Release` for every new version. Do not
create release tags manually and do not use `npm version patch` directly for
production releases.

## Quick start

### 1. Prepare locally

```bash
git checkout master
git pull origin master

# Make and commit changes, then push them to master.
git add .
git commit -m "feat: new feature"
git push origin master
```

### 2. Verify CI

Wait for the required CI checks to pass before starting a release.

### 3. Run the Release workflow

Go to GitHub → Actions → `Release` → `Run workflow` and select:

- `release_type`: `patch`, `minor`, `major`, a prerelease increment, `exact`,
  or `specific` for an existing tag;
- `version` only for `release_type=exact`;
- `existing_release_tag` only for `release_type=specific`;
- `prerelease` when the GitHub Release should be marked as a pre-release;
- `target_branch`, normally `master`;
- the extensions to publish (`core`, DB2, DuckDB, Oracle, PostgreSQL, Vertica,
  MS SQL Server, MySQL, Snowflake, and/or Access).

There is no draft mode. The workflow creates a published GitHub Release and
publishes the selected extensions to both registries.

## What the workflow does

The workflow:

- synchronizes versions in the core extension and managed companion extensions;
- updates tracked documentation version markers;
- validates the release tag and selected targets;
- runs the release quality, test, and integration gates;
- builds and audits the selected VSIX files;
- attaches the VSIX files, checksums, review report, and combined archive to the
  GitHub Release;
- publishes the same VSIX files to the Visual Studio Code Marketplace and Open
  VSX.

Marketplace and Open VSX publication use the same target selection. A missing
`VSCE_PAT` or `OVSX_TOKEN` stops the normal release before the version bump,
tag, and GitHub Release are created.
The `OVSX_TOKEN` secret is mapped to the `OVSX_PAT` variable expected by the
Open VSX CLI.

## One-time Open VSX setup

Before the first publication:

1. Sign the Open VSX Publisher Agreement.
2. Create the `krzysztof-d` namespace.
3. Claim/verify the namespace when possible.
4. Keep `OVSX_TOKEN` as a repository-level or organization-level GitHub Actions
   secret. Do not put it in source files or workflow logs.

The namespace must match the `publisher` field in the extension manifests.

## Re-publishing and recovery

Use `Publish Extensions` manually when an existing tag must be rebuilt or when
publication needs to be retried:

- provide `release_tag`, for example `v3.17.4`;
- select the same extension targets;
- let the workflow rebuild, audit, attach, and publish them to both registries.

Publishing uses duplicate-safe behavior, so a retry skips versions already
accepted by a registry and continues with missing packages. Registry uploads
are not transactional; if one registry succeeds and the other fails, rerun the
same tag after correcting the reported problem.

## Initial Open VSX backfill

After this workflow change is merged, run `Publish Extensions` for
`v3.17.4` and select all currently managed extensions. This backfills the
current release on Open VSX while duplicate versions are skipped on the
Marketplace. Verify the core page, companion pages, and platform-specific DB2,
DuckDB, and Access packages.

## Important rules

- Do not create release tags manually in the GitHub UI.
- Do not use `npm version patch` for official releases.
- Do not publish a different VSIX manually to only one registry.
- Use the `specific` path for retries or backfills of an existing tag.

## Troubleshooting

### Version mismatch

```bash
node scripts/version-sync.js check
```

### CI or release gate failure

Fix the failing check before retrying the release:

```bash
npm run lint
npm run check-types
npm run test:completion-parity
npm run test:quickfix-regression
```

### Open VSX authorization failure

Verify that:

- the Publisher Agreement was accepted;
- namespace `krzysztof-d` exists and is owned by the token holder;
- `OVSX_TOKEN` is available as a repository or organization secret;
- the token has not expired or been revoked.
