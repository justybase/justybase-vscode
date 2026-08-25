---
title: Statuses and permissions
description: Interpret capability labels, platform boundaries, and the privileges needed for metadata, writes, maintenance, AI, and administration.
audience: reference
category: Reference
status: Supported
last_verified: 2026-08-19
product_version: 3.16.39
---

# Statuses and permissions

## Status labels

| Label | Meaning |
| --- | --- |
| Supported | Implemented on the documented surface for the listed database/runtime. |
| Partial | Common path works; dialect, object type, file format, or platform has a stated boundary. |
| Preview | Available but subject to change or limited validation. |
| Legacy reference | Technical or compatibility appendix retained for repository history; not a current support promise. |
| Read-only | Catalog/introspection or result exploration does not write to the database. |
| Desktop only | Requires VS Code extension-host/webview or native companion runtime. |
| Web only | Available in the self-hosted Web Editor/API, not necessarily in the desktop extension. |

## Permission layers

| Operation | Typical requirement |
| --- | --- |
| Browse metadata | Catalog visibility and object privileges. |
| Read table data | `SELECT`/equivalent on the object. |
| DDL / import / edit | Create/alter/insert/update/delete rights and, for staged flows, temporary/staging privileges. |
| Maintenance | Database-specific admin/maintenance privilege; Netezza session sweep may require system admin. |
| Session monitor/terminate | Monitor visibility and a terminate privilege; provider-specific. |
| Security Panel | Grant/revoke/admin catalog rights. |
| MCP read-only tools | Saved Netezza connection with catalog/EXPLAIN visibility; the selected connection is explicit. |
| Web Editor admin | Authenticated admin role for users and backup/restore; persistent data directory access for the server process. |

The UI can hide an action based on capability metadata, but database authorization remains the final authority. Never infer permission from a visible button alone.
