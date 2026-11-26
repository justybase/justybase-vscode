---
title: Connections and tab context
description: Keep credentials, active database scope, and connection lifetime predictable across SQL tabs.
audience: user
category: Start here
status: Supported
last_verified: 2026-08-19
product_version: 3.23.0
---

# Connections and tab context

JustyBase has two related choices: the connection selected for a SQL tab and the optional global active connection used by commands that do not have an editor context. Making this distinction explicit prevents a query, schema action, or AI request from going to the wrong database.

## Create and test a profile

Open **JustyBase: Connect…**, select the database kind, fill in the connection form, and choose **Test** before saving. Profiles are stored by the extension; passwords go through the VS Code Secrets API. Rename profiles so production and non-production environments are immediately distinguishable.

If your organization runs a service that holds the Netezza login, enable the tunnel and choose **Service login** as the sign-in mode. You then sign in with your login to that service and do not need a database login. See the [tunnel guide](../../database-tunnel.md).

### Netezza TLS

Netezza profiles expose **SSL mode** and an optional **CA certificate (PEM)**. `Default (negotiate)` keeps the existing driver behavior, and the driver prefers an unencrypted session when the server allows it, so it is not a guarantee of encryption. `Require` forces an encrypted session without validating the server certificate; it does not need a certificate file. `Verify full` forces TLS and validates the certificate chain and host name, so select the appliance or CA certificate for a self-signed or private-CA server. No client certificate or private key is required. The CA path is stored with the profile options; the profile password remains in VS Code Secret Storage.

### PostgreSQL TLS

PostgreSQL profiles expose **SSL Mode** with `Default`, `Disable`, `Require`, `Verify CA`, and `Verify full`. `Require` encrypts without validating the server certificate. `Verify CA` validates the certificate chain but not the host name; pair it with **TLS Server Name** when the server certificate names a host that differs from the address, such as through a tunnel. `Verify full` validates both the chain and the host name. **TLS Root CA** selects a PEM root CA for private or self-signed CAs, and **TLS Client Certificate** plus **TLS Client Key** enable mutual TLS; the key must be an unencrypted PEM file. Paths are stored with the profile options, while the password remains in VS Code Secret Storage.

## Select context per tab

Use **Select Connection for SQL Tab** and **Select Database for SQL Tab** when a document needs a different scope from the global connection. The tab context is shown in the SQL editor and is used by completion, diagnostics, DDL, execution, and metadata lookup. `DB.SCHEMA.TABLE`, `DB..TABLE`, `SCHEMA.TABLE`, and quoted identifiers remain distinct object forms; do not remove qualification merely to make a suggestion appear.

Use `Ctrl+N` (`Cmd+N` on macOS) from a SQL tab to create another SQL tab with the same connection and manually selected database. The new tab gets its own connection session when its first query runs; it does not share the previous tab's session.

## Keep a connection open

The default lifecycle opens a connection when work needs it and releases it when possible. Use **Toggle Keep Connection Open (Global)** for a stable interactive session, or **Toggle Keep Connection for Tab** when only one editor needs a persistent session. Persistent sessions can consume server slots; turn the option off when a warehouse has strict session limits.

## Switching and failure behavior

- Changing a tab’s connection invalidates its metadata and language context, then repopulates it from the new connection.
- A lost connection is surfaced in the query and Output panels. Retry reuses the selected profile; it does not silently switch tabs.
- Cancellation requests the driver cancellation and stops further UI rendering. A database that cannot cancel immediately may finish server-side before the connection is reusable.
- Metadata sessions are separate from user query sessions. On Netezza, the optional metadata session sweep needs the configured privilege; user queries are never dropped by that sweep.

## Run As (one-off execution)

When one operation needs higher privileges, do not switch the tab's connection: that closes its session, discards temporary objects, and reloads the metadata context. Use **Run As (one-off)** from the SQL editor context menu instead:

- **Run As: Execute Selection on Another Connection…** (`netezza.runAsSelection`) runs the selected SQL.
- **Run As: Execute Statement on Another Connection…** (`netezza.runAsStatement`) runs the statement under the cursor, or the selection when one exists.
- **Run As: Execute Whole File on Another Connection…** (`netezza.runAsWholeFile`) runs the whole document (or the selection) as one batch.

Each command asks for a saved connection profile, then opens a **transient session** on that profile, executes the SQL, and closes it. The tab keeps its connection, its persistent session, its database override, its metadata context, and its existing result tabs. Results appear as a separate execution in the same result panel; its Logs entries are prefixed with `[Run As: <profile>]`, and the status bar plus a notification report success, failure, or cancellation.

Run As submits an independent request to the [SQL execution queue](../reference/sql-execution-queue.md), so it is not serialized behind the tab's own requests and is cancelled only by its own identity. Unsaved variable prompts and include files are captured when the request is submitted, exactly like a normal run.

Limitations worth knowing:

- The transient session does not see the tab session's temporary tables, session variables, or open transaction.
- The tab's database override is ignored; the selected profile's default database is used.
- Run As never creates or edits connection profiles; only saved profiles are offered. Create and test a profile first (see **Create and test a profile**).
- `DELETE`/`UPDATE` without `WHERE` and `TRUNCATE` always require an extra confirmation, regardless of `justybase.safeExecute.enabled`.
- For a long script that depends on one session, switch the tab connection instead.

## ClickHouse connections

Install the ClickHouse companion and choose **HTTP** or **HTTPS / TLS** in the connection form. The default port is `8123`; use the database name, user, and password accepted by the ClickHouse HTTP interface. HTTPS supports certificate verification or an explicit “encrypt, skip validation” mode for environments where trust is terminated elsewhere. Query results stream over HTTP, and the companion keeps database scope in the selected tab.

## Security checklist

1. Use a read-only database account for exploration and AI context.
2. Do not put passwords in `.sql`, `.vscode/netezza-favorites.json`, `.env`, or issue reports.
3. Keep MCP’s explicitly selected connection separate from the active editor connection.
4. Use a different profile for a database with write privileges and leave safe execution enabled.

## Related settings

`justybase.metadataCache.diskPersistence`, `justybase.metadataCache.crossWindowSync`, `justybase.metadata.sessionSweep.enabled`, `justybase.metadata.sessionSweep.maxAgeMinutes`, `justybase.metadata.fullRefreshColumnConnections`, `justybase.metadata.popularDatabases`, `justybase.metadata.liveFallback`, `justybase.safeExecute.enabled`, and `justybase.query.executionTimeout` are documented in the [settings reference](guide/reference/settings/). Increasing `fullRefreshColumnConnections` opens additional Netezza sessions only during the full-refresh column stage, so choose a value compatible with your warehouse's session and catalog limits. `popularDatabases` and `liveFallback` shape how much metadata is warmed eagerly; the defaults keep other databases lazy.
