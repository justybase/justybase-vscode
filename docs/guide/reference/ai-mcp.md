---
title: Copilot and MCP tools
description: Current AI and MCP tools registered by the VS Code extension, with their access tiers.
audience: reference
category: Reference
status: Supported
last_verified: 2026-11-20
product_version: 3.20.11
---

# Copilot and MCP tools

These catalogs are generated from the VS Code extension registrations and tool
contracts during the documentation build. Both surfaces use the same tool
catalog; `justybase.ai.tools` decides which tools are registered and whether
write or destructive tiers are available.

## Copilot tools

<!-- GENERATED:AI_TOOLS -->

## MCP tools

<!-- GENERATED:MCP_TOOLS -->

Read-only is the default for both MCP transports. Write tools additionally
require the connection in `writableConnections`; HTTP write mode also requires a
per-run bearer token. See the [MCP Server guide](../../legacy/mcp_server/) for
the full access model.
