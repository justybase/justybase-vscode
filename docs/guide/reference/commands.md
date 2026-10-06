---
title: Command reference
description: The complete public Command Palette and context-menu command catalog generated from the current extension manifests.
audience: reference
category: Reference
status: Supported
last_verified: 2026-08-19
product_version: 3.18.6
---

# Command reference

Command titles and identifiers are generated from `package.json` and companion extension manifests. Availability still depends on the selected view, object type, platform, database kind, and permissions.

<!-- GENERATED:COMMANDS -->

## Finding a command

Use the Command Palette and search for the human title. Use the identifier in automation, CodeLens, tests, or issue reports. Commands with a `netezza.` prefix can still be exposed for companion dialects because the shared UI owns the action; the capability guard decides whether it is shown.

## SQL execution queue

**JustyBase: Show SQL Execution Queue** (`netezza.showSqlQueue`) opens the per-tab queue in the JustyBase sidebar. See [SQL execution queue](sql-execution-queue.md) for snapshots, cancellation, recovery, and lifecycle behavior.

See [Dependencies and impact analysis](dependency-analysis.md) and
[Netezza Performance Advisor](netezza-performance-advisor.md) for the new
Schema Browser and SQL analysis actions.
