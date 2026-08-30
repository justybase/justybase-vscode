---
title: JustyBase documentation
description: A practical guide to the JustyBase SQL workspace, from the first connection to production-safe data workflows.
audience: user
category: Start here
status: Supported
order: 1
last_verified: 2026-08-19
product_version: 3.17.10
---

# Work from question to trusted result

JustyBase is a multi-database SQL workspace for VS Code. It combines a parser-backed editor, schema intelligence, operational tools, and a result explorer so the database context stays close to the work.

This portal is the canonical product documentation. The [reference catalog](guide/reference/commands/) is generated from the current extension manifest and the [database matrix](guide/reference/database-support/) is the place to check dialect boundaries. Pages labelled **Desktop only**, **Web only**, **Read-only**, **Partial**, or **Preview** are deliberate product boundaries, not promises of identical behavior everywhere.

## Six workflows worth starting with

| If you need to… | Start here |
| --- | --- |
| Understand why the editor catches a problem before execution | [Parser, LSP and SQL Editor](guide/user/parser-lsp/) |
| Review safety, correctness, performance, and type warnings | [SQL quality and diagnostics](guide/user/sql-quality/) |
| Explore a large result without losing control of the data boundary | [Data Grid and Result Exploration](guide/user/data-grid/) |
| Move data between files and databases | [Import and export](guide/user/import-export/) |
| Find an object or a column across a warehouse | [Schema Search](guide/user/schema-search/) |
| Use AI while keeping execution and privacy explicit | [AI SQL Assistant](guide/user/ai-assistant/) |

## Choose your route

### New to JustyBase

Read [Getting started](guide/user/getting-started/), save a connection, open the Schema Browser, and run the small query from that page. Then use [Connections](guide/user/connections/) to understand active database context per tab.

### Moving from another SQL client

The [product guides](guide/user/parser-lsp/) cover the workflows that are easy to miss in a feature list: metadata refresh and [Schema Refresh Details](guide/user/schema-browser/#schema-refresh-details), result-set persistence, all-rows filtering, staged imports, query history, DDL, and maintenance.

### Running the Web Editor

Administrators should start with [Web Editor](guide/admin/web-editor/) and [Deployment and security](guide/admin/deployment-security/). The Web Editor shares parser contracts and result-session concepts with the desktop extension, but it is a separate server with its own authentication and session lifecycle.

### Extending JustyBase

The [developer guide](guide/developer/architecture/) explains the boundaries between contracts, SQL core, runtime, desktop, API, and web. [Testing and documentation](guide/developer/testing-and-docs/) describes the checks expected when a capability changes.

## Status vocabulary

**Supported** means the workflow is implemented and covered by the current product surface. **Partial** means the main path exists but the dialect or platform has a stated limitation. **Preview** marks a capability that may change. **Read-only** means the feature intentionally does not write data. **Desktop only** and **Web only** identify platform-specific surfaces. See [Statuses and permissions](guide/reference/statuses-and-permissions/) for the full legend.

## Version and evidence

This portal was verified against product version **3.17.10** on **2026-08-19**. Generated command, setting, database, AI-tool, MCP, format, and Web API tables are derived from repository sources during the Pages build. The build also publishes machine-readable [build metadata](../build-info.json) with the source commit and generated counts. Narrative pages still require human review when behavior changes.
