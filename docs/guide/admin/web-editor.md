---
title: Web Editor
description: Install, configure, operate, and integrate the self-hosted SQL editor and API.
audience: admin
category: Administration
status: Web only
last_verified: 2026-08-19
product_version: 3.17.11
---

# Web Editor

The Web Editor is a standalone Node.js/Fastify server with a React/Vite frontend. It shares contracts and SQL core with the extension but has its own user login, encrypted connection profiles, query sessions, REST routes, and WebSockets.

## Install and run

```bash
npm install
npm run build:all

JUSTYBASE_MASTER_KEY='use-a-permanent-random-secret' \
JUSTYBASE_ADMIN_USER=admin \
JUSTYBASE_ADMIN_PASSWORD='change-this-password' \
npm run start --workspace @justybase/web-api
```

The default listener is local at `http://127.0.0.1:3000`. For development, build the API, run it in watch mode, and run the Vite frontend in a second terminal. Use `apps/api/.env.example` as a starting point; keep `.env` out of source control.

## Required configuration

- `JUSTYBASE_MASTER_KEY` must remain stable for a data directory. It encrypts saved connection passwords. Rotating it without a migration makes existing ciphertext unreadable.
- `JUSTYBASE_DATA_DIR` should point to persistent, access-controlled storage. It contains the application SQLite store, backups, local databases, and query sessions.
- `JUSTYBASE_ADMIN_USER` and `JUSTYBASE_ADMIN_PASSWORD` create/bootstrap the initial administrator. Change the bootstrap password policy before exposing the service.
- Configure host/port and web distribution through the API config when deploying behind a reverse proxy.

## User workflow

Users log in, manage their own connection profiles, browse a lazy schema tree, search objects, edit preferences, run/cancel queries, view history, inspect streamed/disk-backed results, and export or import the formats exposed by the Web contract. Web result export supports CSV, CSV.GZ, CSV.ZST, JSON, XML, SQL INSERT, Markdown, XLSX, and XLSB; file import accepts CSV, XLSX, and XLSB. Desktop-only Parquet, file-preview, and XPT workflows are not Web Editor support. The default connection profile is read-only unless the user explicitly enables writes in the request/preview flow.

## Security boundary

The server uses an HttpOnly session cookie plus a CSRF cookie/header pair for state-changing routes. Login is rate-limited; query actions are rate-limited; resources are scoped to the authenticated user. Run behind HTTPS or a trusted reverse proxy in production, set secure cookies in production, and do not expose the development listener directly to the internet.

Back up the application data directory before restore. Restore requires admin role, a confirmation, no running query jobs, and writes a safety copy before replacing the store. See [Backup and restore](guide/admin/backup-restore/).

## Query sessions

The server stores result rows in a separate SQLite query-session directory so the browser does not receive one giant JSON blob. The default session TTL is one hour. Clients should handle `RESULT_EXPIRED`, reconnect the event stream with its last sequence, and treat partial/cancelled jobs as incomplete.

## Local sandbox

SQLite and DuckDB profiles run locally under the configured data directory. They are useful for file SQL and testing but are not a remote warehouse connection. Restrict the data directory and review file paths supplied to imports.

## Integration contracts

Use the [Web API reference](guide/reference/web-api/) for REST routes, request/response types, export formats, query events, and LSP WebSockets. `packages/contracts` is the additive shared boundary. Web-internal protocol details can change with the product release; no runtime API change is made by this documentation project.
