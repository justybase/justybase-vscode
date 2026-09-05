---
title: Settings reference
description: Browse the current JustyBase settings, defaults, and configuration boundaries generated from the extension manifests.
audience: reference
category: Reference
status: Supported
last_verified: 2026-08-19
product_version: 3.17.13
---

# Settings reference

The table below is generated from the root and companion extension manifests during the documentation build. Values are defaults, not recommendations for every warehouse. Open **JustyBase: Open Settings** or edit `.vscode/settings.json` with the exact key.

<!-- GENERATED:SETTINGS -->

## High-impact groups

- `justybase.query.*` controls fetched row limits and execution timeouts.
- `justybase.results.*` controls result retention, SQLite spill, formatting, and export display values.
- `justybase.metadata.*` and `justybase.cacheTTL` control catalog refresh and persistence. `justybase.metadata.fullRefreshColumnConnections` (1 by default, up to 8) controls the optional physical-session pool used only for the full-refresh column stage.
- `justybase.linter.*` controls quality diagnostics and severity.
- `justybase.copilot.*` and `justybase.mcp.*` control AI availability, context, privacy confirmation, and read-only tools.
- `justybase.importWizard.*` controls preview and background validation.

Use the exact keys in the generated table. The current query controls are `justybase.query.rowLimit` and `justybase.query.executionTimeout`.
