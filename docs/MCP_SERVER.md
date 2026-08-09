# Netezza MCP Server

The extension bundles a read-only **Model Context Protocol (MCP)** server that exposes Netezza schema
introspection and SQL tooling to AI agents:

- **Copilot Chat in VS Code** (stdio mode) — registered via
  `vscode.lm.registerMcpServerDefinitionProvider` (`contributes.mcpServerDefinitionProviders`).
- **External MCP clients on the local machine** (HTTP mode, `127.0.0.1`) — Cursor, Claude Desktop and
  other clients connect to `http://127.0.0.1:37210` while VS Code is open.

All MCP configuration lives in the custom **JustyBase Settings → MCP Server** section: connection selection,
on/off switches for both modes, the HTTP port, live status, tools and the OpenCode configuration snippet.

## What this enables

MCP turns JustyBase into a safe schema companion for AI-assisted SQL work. An agent can discover the right
database object, inspect its columns and DDL, search the catalog, validate SQL locally, or request a read-only
`EXPLAIN` plan — without being allowed to run `INSERT`, `UPDATE`, `DELETE`, DDL, or arbitrary SQL.

Choose the integration that matches your workflow:

- **VS Code Copilot Chat** — use the tools directly in agent mode inside VS Code.
- **External MCP clients** — enable the local HTTP server and connect tools such as Cursor, Claude Desktop,
  or OpenCode while VS Code is running.

The selected MCP connection is explicit and independent of the active SQL editor tab. This prevents an agent
from silently switching databases when you change tabs.

## Security model

**Passwords never touch the file system.**

The MCP server is a child process of the extension host. Connection details — including the password
from the VS Code Secrets API — are injected into the process environment only:

| Layer | How credentials are provided |
|-------|------------------------------|
| stdio mode (VS Code) | `resolveMcpServerDefinition` is invoked by the editor right before start; it loads the explicitly selected connection from `ConnectionManager` and fills the `env` of the spawned process |
| HTTP mode (external clients) | the extension spawns `dist/mcp/mcpServer.js --transport http --port N` with the connection env |

No credentials file is ever written. The server exits when VS Code closes (HTTP mode is not a daemon).

## Read-only policy

Every tool is registered with the `readOnlyHint` MCP annotation. The server:

- never accepts arbitrary SQL from the model — catalog queries are constructed internally,
- runs `EXPLAIN` only for a single `SELECT` / `WITH ... SELECT` statement (gate:
  `src/mcp/mcpReadOnlyGate.ts`, shared with the Copilot tools `aiSqlSafety.ts`),
- never reads user table data.

## Offered tools

| Tool | Description |
|------|-------------|
| `get_databases` | No arguments. Lists databases from `_V_DATABASE`. |
| `get_schemas` | Optional `database`; uses the active database, or `_V_USER` when none is available. |
| `get_tables` | Optional `database` and `schema`; returns up to 200 tables from `_V_TABLE`. |
| `get_columns` | Required `tables` array. Accepts `TABLE`, `SCHEMA.TABLE`, `DATABASE.SCHEMA.TABLE` and `DATABASE..TABLE`; returns type and nullability metadata from `_V_RELATION_COLUMN`. |
| `get_procedures` | Optional `database` and `schema`; lists non-builtin procedures from `_V_PROCEDURE`. |
| `get_views` | Optional `database` and `schema`; lists up to 200 non-system views from `_V_VIEW`. |
| `search_schema` | Required `pattern`; optional `database` and `objectType`. `ALL` searches tables, views and procedures; use `COLUMNS` to search column names. Results are limited to 100. |
| `get_ddl` | Required `objectName`; optional `objectType`, `database` and `schema`. Generates DDL through the database DDL provider and supports qualified Netezza names including `DATABASE..OBJECT`. |
| `explain_sql` | Required single `SELECT` or `WITH ... SELECT` in `sql`; optional `verbose` and `database`. Returns the plan captured from driver NOTICE messages. |
| `validate_sql` | Required `sql`. Runs parser and linter validation without a database connection. |

## Using it in VS Code (Copilot Chat)

1. Open *JustyBase Settings → MCP Server*, choose a saved Netezza connection and **Enable** the "Copilot Chat (VS Code)" switch.
2. In the Extensions view → MCP SERVERS → right-click **Netezza MCP Server** → **Start** (or
   `MCP: List Servers`), and confirm trust the first time.
3. The tools become available in agent mode / chat prompts.

The server uses the **selected MCP connection**, which is independent of the active editor connection. The
selected connection must remain a saved Netezza connection with accessible credentials; deletion, type changes
or lost access stop the server and require choosing another connection.

## Using it from other applications (HTTP mode)

1. In *JustyBase Settings → MCP Server*, choose a saved Netezza connection, then enable "Local HTTP Server" and choose a port (default `37210`).
2. In OpenCode, use its `mcp` configuration section and the Streamable HTTP `remote` transport:

```json
{
  "mcp": {
    "netezza-schema": {
      "type": "remote",
      "url": "http://127.0.0.1:37210"
    }
  }
}
```

Requirements and limits:

- the server runs **only while VS Code is open** (child process; no daemon, no credentials file),
- bound to `127.0.0.1` only,
- the listener is reachable by other processes of the same user — tools are read-only,
- changing the selected MCP connection restarts the HTTP child process on the new target.
- changing the active editor connection has no effect on MCP.

## Configuration

`justybase.mcp.enabled` — register the stdio server for Copilot Chat (default `false`)
`justybase.mcp.connectionName` — name of the explicitly selected saved Netezza connection (default empty; no automatic fallback)
`justybase.mcp.externalEnabled` — start the HTTP server on 127.0.0.1 (default `false`)
`justybase.mcp.port` — HTTP port, `1024`–`65535` (default `37210`)

## Architecture

```
VS Code Secrets API ──ConnectionManager──┐
                                         ▼
JustyBase Settings → MCP Server ──► registerMcpServerDefinitionProvider (stdio, resolve injects env)
                                         │
                                         ├──► dist/mcp/mcpServer.js (stdio) ──► Copilot Chat
                                         └──► dist/mcp/mcpServer.js --transport http ──► external clients
```

Shared read-only logic lives in `src/core/catalogIntrospection.ts` (no `vscode` imports), so it is
usable both from the extension host and from the standalone server process. The server entry point is
`src/mcp/mcpServerEntry.ts` (built to `dist/mcp/mcpServer.js` by `esbuild.js`).
