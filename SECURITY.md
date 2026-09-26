# Security policy

The VS Code extension and companion extensions can access database credentials
and query results. Treat connection profiles, SQL text, result data, logs,
backups, and Extension Host artifacts as sensitive.

## Reporting a vulnerability

Please use a private GitHub Security Advisory for this repository:

<https://github.com/justybase/justybase-vscode/security/advisories/new>

If that channel is unavailable, open a public issue with only a neutral title
asking for a private contact; do not include exploit details, credentials,
hostnames, SQL, or customer data. Include the affected version/commit, impact,
reproduction steps that use synthetic data, and any proposed mitigation.

## Security expectations

- Keep database passwords, local secrets, and backup files out of source
  control and CI logs.
- Keep connection profiles read-only unless a write operation is explicitly
  previewed and confirmed. Preview tokens are short-lived and bound to the
  exact user, connection, database, mode, and SQL.
- Do not bypass user confirmation for writes or weaken read-only gates to make
  a test pass. Use a synthetic fixture or an explicit opt-in integration test.
- Review Extension Host screenshots, traces, exports, and backups before
  publishing them; controlled runs may still contain SQL and result values.
- Report dependency vulnerabilities with `npm audit`; update the lockfile and
  run the full validation gates before merging.
