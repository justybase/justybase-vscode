---
title: Backup and restore
description: Protect the Web Editor application store and recover users, profiles, and preferences safely.
audience: admin
category: Administration
status: Web only
last_verified: 2026-08-19
product_version: 3.16.41
---

# Backup and restore

The admin backup contains the Web Editor application store. It is not a database warehouse backup and does not replace source database snapshots or exported query data.

## Backup

1. Sign in with an admin account.
2. Use the admin backup action or `GET /api/admin/backup`.
3. Store the SQLite backup in protected, versioned storage.
4. Record the product version, data directory, master-key identity, and backup date without recording the secret itself.

Backups can include encrypted connection profiles, users, preferences, history, and application state. Protect them accordingly.

## Restore

1. Stop or drain application activity and wait for query jobs to finish.
2. Upload a verified backup through the authenticated admin restore flow.
3. Confirm the restore and provide the file name/content expected by the API.
4. The server creates a pre-restore safety copy, replaces the store, clears query sessions/jobs, invalidates metadata/LSP state, and may require a new login.
5. Verify admin access, connection profiles, CSRF, a metadata request, and a read-only query.

Restore requires the same master key that encrypted the saved connection passwords. A changed or missing key can leave profiles unusable even when the SQLite file itself is intact.

## Recovery notes

If restore is rejected, keep the original store and safety copy untouched, inspect the server log, and resolve authorization/body-size/active-query issues. Do not delete the safety copy until a successful verification query and backup have completed.
