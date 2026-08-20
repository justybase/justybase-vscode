---
title: Testing and documentation workflow
description: Keep parser, runtime, capability, and public documentation changes verifiable as the product evolves.
audience: developer
category: Developers
status: Supported
last_verified: 2026-08-19
product_version: 3.16.37
---

# Testing and documentation workflow

## Baseline checks

```bash
npm run docs:check
npm run check-types
npm run lint
npm run build
```

For the Netezza import protocol, run the live suite separately with credentials in the environment:

```bash
npm run test:netezza:import:integration
```

It validates virtual-stream imports for XLSX/CSV/TXT and clipboard data, plus SQLite and Parquet/File SQL migrations. The Db2 case runs when `DB2_LIVE_TEST_*` credentials and the native `ibm_db` runtime are available. These suites are excluded from the normal unit-test configurations by `scripts/jestLiveDbIgnorePatterns.cjs`.

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
