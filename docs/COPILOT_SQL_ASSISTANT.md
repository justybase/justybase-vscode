---
title: Copilot SQL Assistant
description: Canonical pointer for the current Copilot, Language Model Tool, and read-only MCP workflow.
last_verified: 2026-08-19
product_version: 3.17.8
---

# Copilot SQL Assistant

The public guide is now maintained in the documentation portal:

**[Open the AI SQL Assistant guide](guide/user/ai-assistant/)**

It documents the current workflow and boundaries:

- Fix SQL, Optimize SQL, Explain SQL, Best Practices, Custom Question, and Generate SQL;
- parser diagnostics, table profiles, DDL, favorites, notes, and workspace context;
- privacy confirmations and the data that may be sent to GitHub Copilot;
- the current Language Model Tool contracts and their database requirements;
- `validateSqlOnDatabase` as a guarded, read-only database validation/EXPLAIN operation;
- read-only MCP over stdio or localhost HTTP;
- the difference between an AI suggestion and a user-approved execution.

The generated [AI and MCP reference](guide/reference/web-api/) is built from `src/contracts/copilotTools/contracts.ts`, `src/activation/copilotRegistration.ts`, and `src/mcp/mcpToolCatalog.ts`. This file remains as a compatibility entry point for links to the former Markdown documentation.
