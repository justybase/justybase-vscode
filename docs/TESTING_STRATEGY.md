# Testing strategy

Testing is layered so fast feedback catches local regressions while the real
Extension Host catches protocol, renderer, and lifecycle failures.

## Gates

| Layer | Scope | Command |
| --- | --- | --- |
| Static | TypeScript, contracts, API, web | `npm run check-types`, `npm run check-types:api`, `npm run check-types:web` |
| Lint | Blocking desktop rules plus reported workspace baseline | `npm run lint`, `npm run lint:extended` |
| Unit | Parsers, state machines, providers, utilities | `npm run test:validate` |
| API/web | Fastify routes and React behavior | `npm run test:api`, `npm run test:web` |
| Integration | Local SQLite/DuckDB/Access and configured databases | matching `test:*:integration` script |
| Browser | Bundled webview rendering and recovery | `npm run test:playwright` |
| Extension Host | Real VS Code activation, commands, webview protocol | `npm run test:extension-host` |

The PR baseline is `npm run verify:pr`. Live proprietary databases are nightly
or manual because they require credentials and controlled infrastructure.

## Result-panel scroll contract

Scroll behavior is a protocol contract, not an implementation detail. The
deterministic Extension Host scenario must cover:

1. a wide, virtualized result with enough rows to leave the initial viewport;
2. a non-zero vertical scroll anchor and non-zero horizontal offset;
3. switching to Logs and back to the same result set;
4. switching to a different source and back;
5. hydrate/render settling and debounced scroll persistence;
6. an assertion on both axes, preferably the virtualizer anchor, with a pixel
   tolerance only as a fallback;
7. stable result identity distinct from the Logs identity.

The current fixture uses 12 deterministic rows crossed with itself (144 rows),
drives `scrollResult({ rowIndex: 75, scrollLeft: 320 })`, and captures a
sanitized viewport snapshot. Unit tests additionally verify stable-ID lookup,
legacy timestamp fallback, and rejection of cached state belonging to another
result identity. If the grid persistence algorithm changes, update both levels.

## Live test hygiene

Live suites must be explicitly selected, fail when required environment
variables are missing, create uniquely named fixtures, and drop them in
`finally`. Unit Jest configurations install a network guard; live configurations
replace it with their database setup. Tests must not call a real driver from a
unit mock—inject a client/transport seam instead.

Artifacts are temporary and sanitized. Keep screenshots, traces, exports, and
benchmark output outside source control; inspect screenshots before sharing.
