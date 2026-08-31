# Security policy

JustyBase can store database credentials and, in web deployments, serves
multiple users. Treat connection profiles, query text, result data, backups,
logs, and Extension Host artifacts as sensitive.

## Reporting a vulnerability

Please use a private GitHub Security Advisory for this repository:

<https://github.com/justybase/justybase-vscode/security/advisories/new>

If that channel is unavailable, open a public issue with only a neutral title
asking for a private contact; do not include exploit details, credentials,
hostnames, SQL, or customer data. Include the affected version/commit, impact,
reproduction steps that use synthetic data, and any proposed mitigation.

## Security expectations

- Keep `JUSTYBASE_MASTER_KEY`, database passwords, cookies, and backup files out
  of source control and CI logs.
- Web API deployments must set a strong, persistent `JUSTYBASE_MASTER_KEY` and
  use TLS at the reverse proxy. Do not expose the development bind address
  directly to the public internet.
- Keep connection profiles read-only unless a write operation is explicitly
  previewed and confirmed. Preview tokens are short-lived and bound to the
  exact user, connection, database, mode, and SQL.
- Do not disable CSRF, authentication, or the read-only gate to make a test
  pass. Add a test fixture or an explicit opt-in integration configuration.
- Review Extension Host screenshots, traces, exports, and backups before
  publishing them; controlled runs may still contain SQL and result values.
- Report dependency vulnerabilities with `npm audit`; update the lockfile and
  run the full validation gates before merging.
