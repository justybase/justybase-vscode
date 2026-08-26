---
title: Web Editor API reference
description: Document the existing Web Editor authentication, REST, query-session, export, import, and WebSocket contracts without changing runtime behavior.
audience: reference
category: Reference
status: Web only
last_verified: 2026-08-19
product_version: 3.16.40
---

# Web Editor API reference

This page describes the currently implemented server surface. The API is authenticated unless a route is marked health/authentication. Request and response types are defined in `packages/contracts`; the API does not promise that every web-internal shape is stable for third-party clients.

## Stability labels

| Surface | Stability | Guidance |
| --- | --- | --- |
| `/healthz`, `/api/auth/*`, connection/profile, metadata, history, query, import/export routes | Stable product surface | Use contracts and expect additive fields. |
| `/api/lsp/*` REST helpers and `/api/ws`, `/api/lsp` WebSockets | Web-internal protocol | Use the shared contracts and protocol version from the same product release. |
| Local embedded database details, event timing, generated SQL text | Implementation detail | Do not build a long-lived integration on undocumented internals. |

## REST route inventory

<!-- GENERATED:ROUTES -->

## Query session model

`POST /api/query` starts a job and returns a query id. `GET /api/ws` streams sequenced query events; clients can reconnect with `afterSequence`. Page, aggregate, group, export, and cancel operations address the query/session id. Results are stored in a separate SQLite query-session directory and expire after one hour by default.

The server enforces row limits, query timeouts, per-user rate limits, ownership checks, CSRF on mutating routes, and a read-only boundary for profiles marked read-only. A cancelled or expired session is not a complete result.

## Import and export

The Web Editor result export contract supports CSV, CSV.GZ, CSV.ZST, JSON, XML, SQL INSERT, Markdown, XLSX, and XLSB. File import accepts CSV, XLSX, and XLSB through preview and confirmed import routes. Desktop-only Parquet/file-preview/XPT workflows are not silently presented as Web API support.

## LSP protocol

REST completion, diagnostics, and formatting use shared SQL core contracts. `/api/lsp` is an authenticated JSON-RPC WebSocket for the Monaco language client. It shares parser concepts with the desktop extension but has no `vscode` dependency.

## Error handling

Errors use a code/message shape such as `UNAUTHENTICATED`, `CSRF_FAILED`, `NOT_FOUND`, `RESULT_EXPIRED`, or a route-specific validation code. Clients should show the message, stop dependent actions, and avoid retrying authorization or validation errors indefinitely.

See [Web Editor administration](guide/admin/web-editor/) for deployment, secrets, cookies, backup, and reverse-proxy requirements.

## Active AI and MCP contracts

<!-- GENERATED:AI_TOOLS -->

### MCP tools

<!-- GENERATED:MCP_TOOLS -->
