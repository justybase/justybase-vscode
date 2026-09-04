---
title: Session Monitor and Security Panel
description: Inspect active sessions, query state, users, roles, permissions, and audit-sensitive actions without hiding privilege boundaries.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.12
---

# Session Monitor and Security Panel

## Session Monitor

<figure class="figure-wide">
  <img src="screenshots/session_monitor.png" alt="Session Monitor dashboard with active sessions and resource usage">
  <figcaption>The Session Monitor shows active sessions, running queries, and resource utilization.</figcaption>
</figure>

Open **Session Monitor** from the JustyBase commands or database-specific context. Review session identifiers, user/database, state, query text where exposed by the dialect, elapsed time, and cancellation/termination actions. Treat terminate as a privileged operational action and verify the selected connection before confirming.

The monitor is database-specific. Netezza exposes warehouse/session concepts that do not map one-to-one to SQLite or Access. Metadata sessions created by JustyBase can be swept separately; user query sessions are not swept by the metadata setting.

## Security Panel

Open **Security Panel** for the supported connection. Browse users, groups/roles, object privileges, and relevant catalog information. Use the guided grant/revoke forms for common operations or the raw SQL variant when the database syntax requires a form the UI does not model.

Security actions are not read-only. The panel previews/constructs SQL and asks for confirmation; a successful submission still depends on database permissions and policy. Keep a change record outside the panel for production environments.

## Safe workflow

1. Connect with a read-only account for inspection.
2. Capture the current role/permission state.
3. Switch to an explicitly named administrative profile only for the change.
4. Preview the generated grant/revoke or session action.
5. Confirm target, principal, object, and scope.
6. Re-query the panel and audit/log source after the change.

The Web Editor adds authenticated admin user management, backup/restore, CSRF protection, and audit routes; see [Web Editor administration](guide/admin/web-editor/).
