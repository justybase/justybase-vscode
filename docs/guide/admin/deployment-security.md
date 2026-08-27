---
title: Deployment and security
description: Put the Web Editor behind a secure boundary with durable secrets, cookies, CSRF, backups, and least privilege.
audience: admin
category: Administration
status: Web only
last_verified: 2026-08-19
product_version: 3.17.3
---

# Deployment and security

## Reverse proxy

Terminate TLS at a trusted reverse proxy, forward the original host/protocol correctly, and keep the API/WebSocket upgrade routes available. Proxy both the HTTP API and `/api/ws`/`/api/lsp` WebSockets. Do not publish the development Vite server as the production application.

## Secrets and storage

- Generate a strong `JUSTYBASE_MASTER_KEY` and store it in the deployment secret manager.
- Persist `JUSTYBASE_DATA_DIR` on encrypted, access-controlled storage.
- Restrict backups and query-session files to the service account.
- Never commit `.env`, credentials, cookies, connection ciphertext, or generated runtime data.

## Authentication and authorization

Use a separate account for each human user, keep the admin role small, and use database profiles with least privilege. The built-in login/session layer is suitable for a self-hosted boundary that you control; place OIDC/SSO or an identity-aware proxy in front when organizational policy requires it.

## CSRF and cookies

Mutating API routes require the CSRF value returned as a cookie and echoed in `x-justybase-csrf`. Session cookies are HttpOnly and SameSite-lax; production HTTPS enables secure cookie behavior. Do not disable CSRF validation in a proxy or client.

## Backups and restore

Back up before upgrades and before restore. Restore waits for running queries, creates a pre-restore safety copy, invalidates query/metadata sessions, and may require users to sign in again. Validate users, connections, and a read-only query after restore.

## Operational checklist

- [ ] HTTPS/reverse proxy and WebSocket upgrades verified.
- [ ] Master key and data directory are persistent and private.
- [ ] Admin credentials rotated from bootstrap values.
- [ ] Backup schedule and restore drill documented.
- [ ] Query/session expiry and disk usage monitored.
- [ ] Read-only profiles used for exploration and AI context.
