---
title: Copilot SQL Assistant
description: Canonical pointer for the current Copilot, procedure compilation, Language Model Tool, and MCP access workflow.
last_verified: 2026-11-20
product_version: 3.20.11
---

# Copilot SQL Assistant

The public guide is now maintained in the documentation portal:

**[Open the AI SQL Assistant guide](guide/user/ai-assistant/)**

It documents the current workflow and boundaries:

- Fix SQL, Optimize SQL, Explain SQL, Best Practices, Custom Question, and Generate SQL;
- parser diagnostics, table profiles, DDL, favorites, notes, and workspace context;
- privacy confirmations and the data that may be sent to GitHub Copilot;
- the current Language Model Tool catalog and their database requirements;
- `validate_sql` with `mode=database` as a guarded database validation/EXPLAIN operation;
- `compile_procedure` as a bounded, explicitly confirmed procedure compile/test workflow;
- MCP over stdio or localhost HTTP, read-only by default with opt-in write/destructive tiers;
- the difference between an AI suggestion and a user-approved execution.

The generated [Copilot and MCP reference](guide/reference/ai-mcp/) is built from `contributes.languageModelTools` and `src/core/assistant/toolCatalog.ts`. This file remains as a compatibility entry point for links to the former Markdown documentation.
