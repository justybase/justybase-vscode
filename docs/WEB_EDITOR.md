# Web Database Editor

The maintained portal guide is [Web Editor](https://justybase.github.io/justybase-vscode/guide/admin/web-editor/) and the generated route/type inventory is [Web Editor API reference](https://justybase.github.io/justybase-vscode/guide/reference/web-api/). This appendix remains the compatibility/developer reference.

The project now ships two applications:

- the existing VS Code extension,
- a web editor running as a standalone Node.js server.

## Running

From the repository root:

```bash
npm install
npm run build:all

JUSTYBASE_MASTER_KEY='put-a-permanent-random-secret' \
JUSTYBASE_ADMIN_USER=admin \
JUSTYBASE_ADMIN_PASSWORD='change-this-password' \
npm run start --workspace @justybase/web-api
```

The editor is available by default at `http://127.0.0.1:3000`.

`JUSTYBASE_MASTER_KEY` must remain constant for a given data directory — it is used to encrypt connection passwords. Example variables are in [apps/api/.env.example](../apps/api/.env.example).

## Development mode

First build the API, then start it in watch mode:

```bash
npm run build:api

JUSTYBASE_MASTER_KEY=local-dev-master \
JUSTYBASE_ADMIN_USER=admin \
JUSTYBASE_ADMIN_PASSWORD=admin-pass \
npm run dev --workspace @justybase/web-api
```

In a second terminal, start Vite:

```bash
npm run dev --workspace @justybase/web
```

The frontend uses Vite's proxy to reach the API on port `3000`.

For a separately hosted frontend, set `VITE_API_HTTP_BASE_URL` when building
it. `VITE_API_WEBSOCKET_BASE_URL` is optional: when omitted, the client derives
the `ws:`/`wss:` origin from the HTTP base URL. If both are omitted, the client
uses same-origin `/api` and WebSocket URLs. The WebSocket setting is an origin
and the client appends `/api/ws` and `/api/lsp`.

The shared UI composition remains opt-in. Set `VITE_UI_MODE=shared` when
running Vite or building the frontend to enable it; omit the variable (or set
it to another value) to keep the legacy workspace.

The API must also be configured with the exact frontend origin(s), separated
by commas, in `JUSTYBASE_WEB_ORIGINS` (for example,
`JUSTYBASE_WEB_ORIGINS=https://editor.example.test`). This enables
credentialed CORS and the remote CSRF-token bootstrap; wildcard origins are
not supported. Separately hosted cross-site deployments must use HTTPS/WSS
because the session and CSRF cookies then use `SameSite=None; Secure`; HTTP is
supported for same-site local development with `SameSite=Lax`.

## Current scope

The web editor includes:

- local login, encrypted Netezza connection profiles with full CRUD,
- lazy-loaded schema tree: databases → schemas → object groups → objects → columns,
- schema object search and column inspector,
- Monaco editor with Netezza SQL completion and diagnostics from the same parser core as the VS Code extension,
- query tabs, per-user editor preferences, and query history,
- query cancellation and streaming results over WebSocket,
- disk-backed result sessions with filtering, sorting, pinning, and pagination in TanStack Table,
- export of the filtered view to CSV, CSV gzip/zstd, JSON, XML, SQL INSERT, Markdown, and XLSX.

Results are not sent as a single large JSON blob to the browser. The API stores them in a separate SQLite database at `JUSTYBASE_DATA_DIR/query-sessions`, and the grid fetches pages on demand. Sessions expire after one hour by default.

## Packages and data flow

- `packages/contracts` — shared API, result session, tree, and preference contracts,
- `packages/sql-core` — bundled Netezza parser/completion/validator used by the WebSocket LSP,
- `packages/database-runtime` — UI-independent Netezza query and metadata runtime,
- `apps/api` — Fastify server: sessions, profiles, metadata, query sessions, exports, and LSP WebSocket,
- `apps/web` — React frontend: Monaco, Schema Tree, and TanStack Table.

For quick validation of web changes:

```bash
npm run check-types:api
npm run check-types:web
npm run test:api
npm run build:all
```

Production configuration should additionally set a persistent data directory, HTTPS/reverse proxy, and external authentication (OIDC/SSO) if the application is to be exposed beyond the local network.
