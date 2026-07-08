# Release Process

Use the GitHub Actions workflow named `Release` for every new version. Do not create release tags manually and do not use `npm version patch` directly for production releases.

## Quick Start

### Step-by-step release process

#### 1. Local preparation

```bash
# Ensure you're on main branch
git checkout main
git pull origin main

# Make your changes, fixes, features
git add .
git commit -m "feat: new feature"  # or "fix: bug fix"
git push origin main
```

#### 2. Verify CI passes

- Go to GitHub → Actions → CI
- Wait for all checks to pass ✅
- Do not proceed if CI fails

#### 3. DO NOT change version locally

- ❌ Do NOT use `npm version patch`
- ❌ Do NOT edit package.json manually
- ✅ Let GitHub Actions manage versions

#### 4. Trigger Release workflow

- Go to: GitHub → Actions → Release → "Run workflow"
- Select parameters:
  - `release_type`: `patch` (1.1.3 → 1.1.4) or `minor` (1.1.3 → 1.2.0)
  - `draft`: `true` (recommended for safety)
  - `target_branch`: `main`

#### 5. Workflow automatically

- Bumps version in package.json files
- Creates commit "chore: release X.X.X"
- Creates tag `vX.X.X`
- Creates GitHub Release (draft)

#### 6. Publish (if draft=true)

- Review the GitHub Release
- If everything OK → click "Publish"
- This automatically triggers `Publish Marketplace Extensions`

## Process diagram

```
Local:                         GitHub:
──────                         ───────
git push ───────────────────▶ CI checks
                              (lint, types, tests)
                                     │
                                     ▼
                           Release workflow (manual trigger)
                                     │
                                     ▼
                           ┌─────────────────┐
                           │ 1. Bump version │
                           │ 2. Commit + tag │
                           │ 3. GitHub Rel   │
                           └────────┬────────┘
                                    │
                                    ▼
                           Publish Marketplace
                           (auto on release publish)
```

## What the workflow does

The workflow:

- updates synchronized versions in the root extension and any managed optional extensions that are present (Db2, Oracle, PostgreSQL)
- validates version consistency with `scripts/version-sync.js`
- runs lint and type checks (tests run in CI, not in release)
- creates a release commit on the selected branch
- creates and pushes an annotated git tag
- creates a GitHub Release

If the workflow creates a published release (`draft=false`), it now directly runs the existing `Publish Marketplace Extensions` workflow as a reusable workflow for that tag. This avoids relying on a second GitHub Actions trigger from a release created by `github-actions[bot]`.

If you create a draft release (`draft=true`) and later click **Publish** in the GitHub UI, the same `Publish Marketplace Extensions` workflow still starts automatically from the release event and publishes the core VSIX plus any optional extension VSIX packages produced for that tag.

## Recommended usage

### Safe rehearsal

Use this when you want to practice the process without publishing to Marketplace yet.

- Run workflow: `Release`
- `release_type`: `patch` or `exact`
- `draft`: `true`
- `prerelease`: optional
- `target_branch`: `main`

Result:

- the version bump commit is pushed
- the tag is pushed
- a draft GitHub Release is created
- Marketplace publishing does not start until the draft release is manually published

### Real release

- Run workflow: `Release`
- `release_type`: `patch`, `minor`, `major`, or `exact`
- `draft`: `false`
- `prerelease`: set as needed
- `target_branch`: `main`

Result:

- the release commit and tag are pushed automatically
- a published GitHub Release is created automatically
- Marketplace publishing starts immediately in the same release workflow

## Exact version mode

Use `release_type=exact` only when you must publish a specific version such as `1.2.3`. In that mode, `version` is required.

## Important rules

- Do not create release tags manually in GitHub UI.
- Do not use `npm version patch` for official releases.
- Do not edit the GitHub Release first and tag later.
- Let the workflow create the commit, tag, and release in one path.

## After a draft rehearsal

If you created a draft release only for testing, you can:

- publish the draft later to trigger Marketplace publishing, or
- delete the draft release and delete the tag if it was only a rehearsal

## Troubleshooting

### Version mismatch error

If you see "Version mismatch detected", run locally:

```bash
node scripts/version-sync.js check
```

To fix, synchronize versions:

```bash
node scripts/version-sync.js set 1.1.3
```

### CI fails before release

Do not trigger Release workflow until CI passes. Fix the issues first:

```bash
npm run lint
npm run check-types
npm run test:completion-parity
npm run test:quickfix-regression
```
