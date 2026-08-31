# Contributing to JustyBase

JustyBase is a monorepo containing the VS Code extension, companion database
extensions, shared SQL/runtime packages, and the self-hosted web editor. Small
changes should stay inside the owning package; cross-cutting changes must keep
the desktop and web contracts compatible.

## Local setup

Use Node.js `>=22.12.0` and npm. From the repository root:

```bash
npm install
npm run check-types
npm run lint
npm run test:fast -- --runInBand
```

For a pull-request-equivalent check run `npm run verify:pr`. It covers the root
and workspace type checks, blocking lint, the complete root validation suite,
API and web tests, and the API/web production build. The deterministic result
panel gate additionally runs:

```bash
npm run test:extension-host
npx playwright test --config=test-harness/playwright.config.ts \
  test-harness/tests/table-rendering.spec.ts
```

The Extension Host gate uses temporary SQLite data. It also verifies a real
virtualized grid: a 144-row, wide result is scrolled vertically and
horizontally, switched through Logs and another source, and checked using the
virtualizer anchor and both scroll axes. This is the minimum regression level
for result-panel state changes; unit tests alone are not sufficient.

Live database suites are opt-in. Configure credentials through environment
variables only and use the matching command (`test:postgres:integration`,
`test:db2:integration`, `test:extension-host:netezza`, and so on). Never commit
`.env` files, credentials, generated traces, screenshots, benchmark results,
or database fixtures containing customer data.

## Change boundaries

- `packages/contracts` is the additive public boundary shared by desktop, web,
  and API. Preserve optional-field and backwards-compatibility semantics.
- `packages/sql-core` must remain independent of `vscode`.
- `packages/database-runtime` owns reusable execution and safety helpers.
- `src/` and `media/` are desktop implementation layers; do not add
  Netezza-only assumptions to shared providers.
- Build outputs belong in local `dist/` directories and must not be committed.

When changing SQL syntax, update the lexer, parser, visitor/validator,
TextMate grammar, and snippets together. When changing a webview protocol,
update the host contract, webview contract, and an end-to-end protocol test.

## Pull requests

Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`,
`test(scope): ...`) with a first line shorter than 72 characters. A PR should
describe the behavior change, compatibility impact, security/data risk, and
the validation commands that were run. Include screenshots only for controlled
fixtures; review them for SQL and row values before sharing.
