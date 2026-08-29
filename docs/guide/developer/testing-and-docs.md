---
title: Testing and documentation workflow
description: Keep parser, runtime, capability, and public documentation changes verifiable as the product evolves.
audience: developer
category: Developers
status: Supported
last_verified: 2026-08-19
product_version: 3.17.6
---

# Testing and documentation workflow

## Baseline checks

```bash
npm run docs:check
npm run check-types
npm run lint
npm run build
```

For the Netezza import protocol, run the focused live suite separately with credentials in the environment:

```bash
npm run test:netezza:import:integration
```

It validates virtual-stream imports for XLSX/CSV/TXT and clipboard data, plus SQLite and Parquet/File SQL migrations. The Db2 case runs when `DB2_LIVE_TEST_*` credentials and the native `ibm_db` runtime are available. These suites are excluded from the normal unit-test configurations by `scripts/jestLiveDbIgnorePatterns.cjs`.

The complete Netezza live contract is available through one command:

```bash
NZ_DEV_PASSWORD='...' \
NZ_DEV_ALLOW_FIXTURE_DDL=1 \
npm run test:netezza:integration
```

This command includes the driver, parser/linter, metadata refresh, import/file-migration, CTE, macro, completion, timestamp, MCP, timeout, and advanced-feature suites. The advanced-feature suite creates uniquely named tables, views, procedures, external tables, and synonyms in `NZ_DEV_SCHEMA` (default `ADMIN`) and removes only those names in `afterAll`. `NZ_DEV_ALLOW_FIXTURE_DDL=1` is required because the suite executes DDL and maintenance statements. Missing XLSX samples are treated as a failed import contract; provide them with `NZ_IMPORT_SAMPLES_DIR`.

The complete command is intentionally local/manual: GitHub Actions does not provide a Netezza instance. Run it on a machine or self-hosted runner that can reach the warehouse. Credentials must remain environment variables or local secret-manager values and are never stored in the repository.

The session-kill scenario is excluded by default; run it separately with `NZ_DEV_ALLOW_SESSION_KILL=1` only when terminating a disposable test session is acceptable. Import fixtures additionally require `NZ_IMPORT_SAMPLES_DIR` to point to local sample files. Cross-database migration tests remain a separate manual suite because they require optional target runtimes and credentials.

The timeout/session-isolation suite is also skipped by the aggregate command unless `NZ_DEV_RUN_TIMEOUT_TESTS=1` is set; its assertion depends on a deliberately slow query and local data volume.

The Pages workflow runs the documentation build and checker on pull requests. `docs:check` builds `_site`, validates generated catalogs for both missing and extra entries, checks product versions and calendar dates in front matter, records the source commit/counts in `build-info.json`, checks generated local links/anchors and stale setting/tool names, and verifies the six product pillars are present. New user-facing commands that need explanation must also appear in a canonical guide page; the generated command reference is not a substitute for workflow documentation.

## Parser changes

Update lexer, parser, visitor, built-ins, TextMate grammar, and snippets as appropriate. Add a focused regression test for every accepted keyword/block form and run the dialect construction-performance guardrail. Avoid duplicate Chevrotain token consumption and broad recursive block alternatives.

## Capability changes

When adding a command, setting, `DatabaseKind`, Copilot/Language Model tool, MCP tool, Web API route, or import/export format:

1. Update its source contract/manifest.
2. Add or update the user workflow page and relevant status/boundary.
3. Run `npm run docs:check` and inspect generated reference pages.
4. Add tests for permission, cancellation, error, and large-data behavior where relevant.
5. Update the Marketplace README only as a short pointer; keep details in the portal.

## Link and accessibility checks

Use headings with stable text, descriptive link labels, alt text for screenshots, keyboard-accessible controls, and a useful no-JavaScript navigation path. The generator adds anchor links, breadcrumbs, a sidebar, code-copy buttons, and a client-side search index without making navigation depend on JavaScript.

## Benchmark language

Publish benchmark methodology and version/machine context, not universal SLA claims. Parser and Result Panel performance suites are regression guardrails. Keep generated timing files out of commits.

The Data Grid suite has its own [performance benchmark playbook](guide/developer/performance-benchmarks/). Run `npm run benchmark:data-grid` for deterministic Node/Jest coverage and `npm run test:playwright:data-grid-performance` for the real Result Panel bundle and worker. Keep baseline changes separate from feature changes and explain any new operation boundary.
