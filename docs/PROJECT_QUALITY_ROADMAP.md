# Project Quality Improvement Roadmap

Last audited: 2026-08-31

Baseline commit: `05f1ad8`

Roadmap mode: quality-first, exit-criteria driven

This is the canonical engineering-quality backlog for the repository. Product
capability detail remains in the capability matrices and parity audit; this
document owns cross-cutting quality priorities, measurable exit criteria, and
the order in which the work should be undertaken.

The roadmap is a living document. A completed item must link to its tests or CI
evidence, update affected contracts and user documentation, and record the date
on which its acceptance criteria were verified.

## Status and priority model

| Field | Values |
| --- | --- |
| Status | `planned`, `in-progress`, `blocked`, `done` |
| Priority | `P0` release/safety risk, `P1` material quality or product value, `P2` longer-term improvement |
| Effort | `S` hours, `M` 1–3 days, `L` 1–2 weeks, `XL` multi-week |
| Owner | Maintainer role responsible for evidence and status, not necessarily the sole implementer |

Work is ordered by exit criteria rather than dates. New functionality may be
developed in parallel only when its affected subsystem already meets the P0
quality gates below.

## Audited baseline

The following measurements were collected from the baseline commit on
2026-08-31. They are starting points, not targets to preserve indefinitely.

| Area | Baseline | Evidence |
| --- | --- | --- |
| Static and build | Architecture check, root/media type checks, root and extended lint, documentation check, desktop build, and API/web builds pass | `npm run check:architecture`, `npm run check-types`, `npm run lint`, `npm run lint:extended`, `npm run docs:check` |
| Root tests | 524 suites, 9,247 tests, and one snapshot pass | `npm run test:validate` |
| Root teardown | Jest force-exits one worker after the successful run | `npm run test:validate` output |
| Root coverage | 72.28% statements, 58.59% branches, 77.08% functions, 72.76% lines | `npm run test:coverage` |
| API tests | 12 suites and 55 tests pass | `npm run test:api` |
| React web tests | 1 suite and 3 tests pass | `npm run test:web` |
| Browser tests | 30 Playwright tests pass | `npm run test:playwright` |
| Extension Host | Deterministic SQLite Result Panel scenario passes | `xvfb-run -a npm run test:extension-host` |
| Extended lint | 452 warnings: 436 in `media`, 7 in `apps`, 7 in `packages`, and 2 in the MSSQL companion | `npm run lint:extended` |
| Dependency audit | No known production or development vulnerabilities reported | `npm audit --audit-level=high` |
| Documentation | 68 generated pages and current catalog/link checks pass | `npm run docs:check` |

The global coverage average hides uneven risk. Parser and dialect code is near
87–89% line coverage, while migration is about 27%, activation 41%, views 49%,
commands 59%, imports 58%, and exports 64%. The largest non-generated modules
also concentrate orchestration and UI state: Result Panel bootstrap and host
view code exceed 3,000 lines, while schema, metadata prefetch, filters, and grid
construction exceed 2,000 lines.

The dependency-boundary check currently protects only three shared-package
roots from importing `vscode`. It does not detect cycles or enforce the full
desktop/shared/API/web dependency direction.

## Definition of done by risk

Every change keeps type checks, lint, affected builds, and targeted tests green.
Additional requirements are based on risk:

| Risk | Examples | Required evidence |
| --- | --- | --- |
| Low | Pure utility, copy, non-behavioral documentation | Unit tests where behavior changes; documentation check for public changes |
| Medium | Provider, parser, metadata mapping, isolated UI behavior | Direct branch tests, integration test at the nearest real boundary, coverage review, compatibility note |
| High | Execution, streaming, cancellation, persisted state, authentication, write operations, migrations, shared contracts | Unit/state-machine tests, real runtime or browser/Extension Host test, failure and cleanup cases, security review, documentation and rollout evidence |

High-risk work is not complete when only a mocked happy path passes. It must
prove identity, state transitions, invalidation, failure recovery, cleanup, and
backward compatibility at the closest production boundary.

## QG — Quality governance and metrics

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| QG01 | P0 | M | Build/CI maintainer | done | Added the ignored, schema-versioned quality report (`quality/quality-report.v1.schema.json`) and reproducible artifact command (`npm run quality:report`). Evidence: `scripts/quality-report.mjs`, `scripts/quality-tools.test.mjs`. Verified 2026-08-31. |
| QG02 | P0 | S | Repository maintainer | done | Applied the risk-based definition of done, state/failure matrix, and cleanup evidence to the PR template and contributor guide. Evidence: `.github/pull_request_template.md`, `CONTRIBUTING.md`. Verified 2026-08-31. |
| QG03 | P0 | M | Test maintainer | done | Enforced global floors of 71% statements, 58% branches, 76% functions, and 72% lines, plus 80% changed-line/70% changed-branch coverage for high-risk `src/` roots. Evidence: `jest.config.js`, `scripts/quality-gate.mjs`, CI unit job. Verified 2026-08-31. |
| QG04 | P0 | M | Frontend maintainer | done | Reduced the extended-lint baseline from 162 to 70 warnings (57 `media`, 7 `apps`, 6 `packages`, 0 `extensions`) while keeping the ratchet blocking. The Phase 1B target of 100 warnings is met. Evidence: `quality/quality-baseline.json`, `npm run lint:extended:check`. Verified 2026-08-31. |
| QG05 | P1 | S recurring | Repository maintainer | planned | Review this scorecard monthly. A `done` item must include evidence links, verification date, and any follow-up risk; stale or contradicted status returns to `planned`. |

Long-term exit criteria are at least 80% global line coverage, 70% branch
coverage, zero lint warnings, zero forced test-worker exits, and no undocumented
high-risk change merged without multi-layer evidence.

## CQ — Architecture and code quality

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| CQ01 | P0 | XL | Result Panel owner | planned | Decompose Result Panel bootstrap, host messaging, persistence, filtering, selection, and rendering into bounded modules. Preserve existing facades and cycle constraints. Each extraction lands with behavior-parity tests; no new module combines UI rendering, transport, and persistence. |
| CQ02 | P1 | XL | Desktop/API owners | planned | Split the largest host view, schema, metadata-prefetch, API server, and React application coordinators by responsibility. Files above 800 lines trigger design review; generated data and declarative catalogs are exempt. |
| CQ03 | P0 | L | Architecture owner | planned | Extend `check:architecture` to resolve imports, enforce contracts → platform-neutral core/runtime → adapters → UI direction, and detect cycles across desktop, media, API/web, and companions. Keep the explicit Result Panel no-cycle rules. |
| CQ04 | P0 | L | Webview protocol owner | done | Replaced Result Panel catch-all messages with exhaustive host/webview unions and runtime validation at both untrusted boundaries. Compile-time command sync and negative rejection paths are covered. Evidence: `media/resultPanel/hostContracts.ts`, `media/resultPanel/protocol.ts`, `src/contracts/webviews/resultPanelRuntime.ts`, `src/__tests__/resultPanelProtocol.test.ts`, `src/__tests__/resultPanelView.scroll.test.ts`. Verified 2026-08-31. |
| CQ05 | P0 | M | Result state owner | done | Wrapped persisted grid state in a versioned envelope keyed by stable `resultSetId`, with documented timestamp fallback, legacy migration, and safe reset for corrupt or future state. Evidence: `media/resultPanel/grid/persistence.ts`, `src/__tests__/resultPanelMessagesScroll.test.ts`. Verified 2026-08-31. |
| CQ06 | P1 | L | Subsystem owners | planned | Preserve caught error causes, remove empty catches and unused branches, and define ownership for timers, listeners, workers, connections, temporary files, and database sessions. Tests must assert cleanup. |
| CQ07 | P1 | S | Access package owner | planned | Mark Access index-code data as generated, document and verify its generator/checksum, and exclude it from hand-written size and coverage metrics. |

Architecture completion means zero new cycles, no `vscode` dependency in shared
packages, no untyped high-traffic webview command, and no state migration that
silently applies data belonging to another result identity.

## TQ — Deep, live, and stateful testing

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| TQ01 | P0 | M | Test infrastructure owner | done | Fixed the unit network guard so blocked sockets emit an asynchronous error and database-driver timeout cleanup runs. The complete suite now terminates naturally without forced exit. Evidence: `src/__tests__/unitNetworkGuard.setup.ts`, `src/__tests__/metadataDiskCompress.test.ts`, `npm run test:validate`. Verified 2026-08-31. |
| TQ02 | P0 | L | Test maintainer | planned | Raise coverage first in migration, activation, views, commands, editors, imports, and exports. Reach the changed-code gate before increasing global thresholds toward 80% lines/70% branches. |
| TQ03 | P0 | XL | UI owners | in-progress | Result Panel now has an executable host-state contract covering stable identity, pinned/index transitions, source removal, streaming cancellation, late-chunk rejection, and active-source recovery. Evidence: `src/__tests__/resultPanelStateContract.test.ts`, `docs/RESULT_PANEL_REGRESSION.md`. Extend the same contract to the remaining stateful panels. Verified 2026-08-31. |
| TQ04 | P0 | L | Web owner | planned | Add jsdom and Testing Library coverage for React tabs, editor preferences, connection dialogs, schema navigation, result-grid state, errors, cancellation, and reload restoration. The current three reducer tests are insufficient for the shipped surface. |
| TQ05 | P0 | L | Browser/host test owner | planned | Put high-traffic webviews, not only smoke rendering, under Playwright or Extension Host CI. Replace fixed waits with observable readiness where possible and retain sanitized failure snapshots/traces. |
| TQ06 | P0 | XL | Execution owner | done | Desktop reconnect replay is limited to one proven call-free read-only statement before any streamed chunk. Result transport now carries stable identity, row offsets, and monotonic sequence; duplicate/delayed chunks are ignored and gaps/out-of-order delivery recover through one authoritative hydrate. The Extension Host runner retains per-iteration evidence and has a weekly Linux 20x race gate. Evidence: `src/core/queryRetrySafety.ts`, `media/resultPanel/streamingSequence.ts`, `src/__tests__/streamingSequence.test.ts`, `src/__tests__/resultPanelHydrateDedup.test.ts`, `scripts/extensionHost/extensionHost.js`, `.github/workflows/result-panel-regression.yml`. Verified 2026-09-01. |
| TQ07 | P1 | L | Metadata owner | done | Restart, corrupt metadata/columns, stale TTL, committed DDL invalidation, same-process prefetch deduplication, two-writer fence ordering, lock expiry, v2-column-to-v3 rewrite, future/legacy isolation, fingerprint changes, external refresh, and host↔LSP invalidation are covered. Evidence: `src/__tests__/metadataCache.diskPersistence.test.ts`, `src/__tests__/metadataDiskStorage.test.ts`, `src/__tests__/metadataDiskLock.test.ts`, `src/__tests__/tableDdlSynchronizer.test.ts`, `src/__tests__/metadataHostLspCoherence.test.ts`, `src/__tests__/integration/metadataCacheRestart.integration.test.ts`. Verified 2026-09-01. |
| TQ08 | P1 | XL | Data movement owner | planned | Add import/export/migration round trips for nulls, Unicode, large integers, decimals, timestamps/time zones, duplicate headers, empty files, cancellation, partial failure, and temporary-resource cleanup. |
| TQ09 | P1 | XL | Dialect owners | planned | Build a reusable dialect contract for connection, metadata, completion, diagnostics, quoting, cancellation, read-only behavior, DDL, and import/export. Run local/container databases on PRs and controlled credentialed systems on schedules. |
| TQ10 | P2 | L | Core test owner | planned | Add property-based tests for identifiers, quoting, state keys, pagination, and format round trips. Run targeted mutation testing periodically on pure safety-critical modules rather than on every PR. |
| TQ11 | P1 | M | CI owner | done | The weekly Linux Result Panel workflow runs `JUSTYBASE_EXTENSION_HOST_REPEAT=20`, retains per-iteration sanitized reports/traces and an aggregate summary, records duration/pending requests/artifact availability, and fails after collecting all iteration outcomes. Evidence: `.github/workflows/result-panel-regression.yml`, `scripts/extensionHost/extensionHost.js`, `docs/RESULT_PANEL_EXTENSION_HOST_RUNBOOK.md`. Verified 2026-09-01. |

### Reference Result Panel state matrix

The existing scroll tests are the depth standard, not a one-off exception. Keep
their current source/result switching coverage and add any missing cells below.

State to preserve:

- vertical offset, horizontal offset, and virtualizer anchor;
- sorting, global and column filters, grouping, and expanded groups;
- column order, width, visibility, and pinning;
- result formatting, alternate view, and disk-group expansion state.

Identity and invalidation:

- key state by source URI, result index, and stable `resultSetId`;
- accept execution timestamps only as the documented legacy fallback;
- never restore state from another result identity;
- invalidate incompatible state on a new execution while retaining explicitly
  pinned historical results.

Transitions:

- Logs → result → Logs → the same result;
- result set → another result set and back;
- source/editor tab → another source and back;
- panel hide/reveal and initially zero-sized layout;
- webview reload/revival and VS Code window reload where persistence applies;
- pin, unpin, close, index shift, refresh, and new execution;
- active streaming, cancellation with partial rows, disk-backed data, and empty
  results.

Assertions and layers:

- prefer exact stable identity and virtualizer-anchor assertions;
- assert both axes; use pixel tolerance only when no anchor exists;
- wait for hydrate, layout, and persistence acknowledgement rather than sleep;
- cover pure persistence logic, bundled DOM behavior, the real Extension Host,
  and scheduled repeated race runs.

### Other mandatory state/failure matrices

- Editor/LSP: rapid edits, stale diagnostics, metadata refresh, connection
  switching, disconnect/reconnect, document close, and server restart.
- Query execution: stream sequencing, retry, cancellation, row limits, partial
  results, multi-statement errors, and late callbacks.
- Metadata: warm/cold cache, incomplete layers, concurrent refresh, disk
  restart, corruption, and schema-changing DDL.
- Web/API: authentication expiry, CSRF, ownership, read-only profiles, tab and
  layout restoration, WebSocket reconnect, and expired query sessions.
- Data movement: format/type boundaries, target rollback or partial-write
  reporting, source/target capability mismatch, and cleanup.

## UX — Accessibility, consistency, and performance

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| UX01 | P0 | L | Frontend owners | planned | Add automated axe checks and keyboard-only flows for the web editor and high-traffic webviews. Fail on serious or critical violations. |
| UX02 | P0 | XL | Panel owners | planned | Complete loading, refresh, empty, error, cancellation, retry, focus restoration, and disabled-action behavior for every panel in the UX audit. |
| UX03 | P1 | L | Accessibility owner | planned | Test accessible names, focus traps, Escape/Enter behavior, grid navigation, selection/copy, high-contrast themes, 200% zoom, and reduced motion. |
| UX04 | P1 | L | Performance owner | planned | Run LSP, typing, quality, hydration, and grid benchmarks on stable scheduled runners. Keep existing parser construction below 2,000 ms and investigate a sustained three-run median regression above 15%. |
| UX05 | P1 | L | Runtime owners | planned | Measure memory and resource stability across repeated query execution, panel recreation, metadata refresh, large results, and worker use. No unbounded growth or retained disposed session is acceptable. |

## DQ — Documentation quality

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| DQ01 | P0 | M | Documentation owner | done | Reconciled the web parity audit with implementation paths and executable evidence, including explicit evidence gaps for React pivot, virtualization, and persisted state instead of treating implemented features as missing or fully proven. Evidence: `docs/WEB_PARITY_AUDIT.md`, `apps/api/tests/querySessions.test.ts`, `apps/api/tests/server.test.ts`, `apps/web/src/queryState.test.ts`. Verified 2026-08-31. |
| DQ02 | P0 | M | Test/documentation owners | done | Testing strategy now owns risk tiers, stateful-test contracts, live-suite selection, coverage ratchets, flake policy, and quality-tooling gates. Evidence: `docs/TESTING_STRATEGY.md`, CI quality/unit jobs. Verified 2026-08-31. |
| DQ03 | P1 | L | Documentation tooling owner | planned | Validate roadmap IDs, statuses, review dates, evidence links, and machine-verifiable feature claims in `docs:check`. |
| DQ04 | P1 | XL | Product/architecture owners | planned | Move capability status toward a generated registry consumed by tests and documentation so implementation and parity claims cannot drift independently. |
| DQ05 | P1 | M | Documentation owner | planned | Clearly label canonical guides, implementation contracts, runbooks, historical notes, and active backlogs; archive or redirect duplicate sources. |

## SQ — Security, supply chain, and release quality

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| SQ01 | P0 | L | API/security owner | planned | Maintain a threat model for authentication, session fixation/expiry, CSRF, rate limiting, ownership, WebSocket isolation, local-file sandboxing, read-only bypass, DDL confirmation, backup/restore, and artifact redaction. |
| SQ02 | P0 | XL | Security/test owners | planned | Add adversarial tests for every trust boundary, including malformed webview messages and SQL intended to bypass read-only classification. Preserve the MCP read-only gate on both transports. |
| SQ03 | P1 | M | Dependency owner | planned | Add weekly dependency updates, CodeQL for JavaScript/TypeScript, release SBOM generation, license checks, and continued production/development dependency audits. |
| SQ04 | P0 | L | Release owner | planned | Install and smoke-test packaged VSIX artifacts on Linux and Windows before publication; development-extension tests alone are insufficient release proof. |
| SQ05 | P0 | S | CI/security owner | planned | Keep traces allow-listed and sanitized. Screenshots remain opt-in and require fixture/data review before external sharing. |

## FQ — Functional completeness

Functional work follows quality readiness; it does not bypass it.

| ID | Pri | Effort | Owner | Status | Work and acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| FQ01 | P0 | M | Product/documentation owner | done | Audited the desktop, shared-package, Web/API, MCP, and ten-companion inventory; restored Snowflake and Vertica to the public matrix as Preview and attached the nearest executable gates to supported claims. Evidence: `docs/WEB_PARITY_AUDIT.md`, `docs/guide/reference/database-support.md`, `scripts/docs-check.mjs`, `.github/workflows/optional-extension-build.yml`. Verified 2026-08-31. |
| FQ02 | P0 | XL | Subsystem owners | planned | Close state loss, cancellation, reload, metadata invalidation, error recovery, and cleanup gaps before increasing feature breadth in that subsystem. |
| FQ03 | P1 | XL | Web owner | planned | After React and API gates exist, prioritize remaining code actions, selected-statement/run modes, durable tab/grid state, metadata refresh, context actions, row detail, and guarded DDL/import workflows. |
| FQ04 | P1 | XL | Dialect owners | planned | Require the common dialect contract before promoting a database from preview to supported. Document unsupported versions and capability differences explicitly. |
| FQ05 | P2 | XL | Product/architecture owners | planned | Defer broad AI, notebook, ETL, ERD, visual-builder, and remote-dialect expansion until their architecture, accessibility, security, and end-to-end gates are defined. |

## Delivery sequence

### Phase 0 — Establish truth (delivered 2026-08-31)

- Publish this roadmap and audited baseline.
- Correct stale web parity and UX claims.
- Define metrics, evidence, status, and ownership rules.

Exit: the active backlog has one canonical location, current claims match code,
and every P0 item has an owner role and measurable acceptance criteria.

### Phase 1 — P0 foundations

- Fix test teardown and freeze coverage/warning baselines.
- Add changed-code, architecture, React, accessibility, and state-contract gates.
- Version persisted state and type high-traffic protocols.

Exit: full tests terminate naturally, quality cannot regress silently, and
high-risk UI/transport changes have enforceable contracts.

### Phase 1A — Quality ratchet (delivered 2026-08-31)

- Add a versioned quality baseline/report and machine-readable lint/coverage
  gates.
- Enforce the initial root coverage floors and changed high-risk coverage in CI.
- Replace the obsolete branch-only PR checklist with risk, state/failure, and
  cleanup evidence requirements.
- Reduce the first Result Panel lint-warning target to 162 warnings and make
  increases blocking.
- Remove the known unit-test timeout leak; the complete Jest suite exits
  naturally.

Exit evidence: `npm run test:quality-tools`, `npm run lint:extended:check`,
`npm run test:validate`, `npm run docs:check`, and `npm run check-types:media`.
The 100-warning milestone was surpassed; the current frozen baseline is 70 and
the next cleanup target is zero warnings. Phase 1 continues with React,
accessibility, architecture, and state-contract gates.

### Phase 2 — Reliability and decomposition

- Expand race, persistence, metadata, execution, and security tests.
- Decompose critical modules without behavior changes.
- Reduce warning and low-coverage hotspots.

Exit: critical subsystems meet their coverage targets, have no unresolved P0
state/failure cells, and have explicit resource ownership.

### Phase 3 — Quality-gated functionality

- Deliver verified web and dialect gaps in FQ priority order.
- Include contracts, integration tests, accessibility, security, and docs in
  the same change.

Exit: promoted functionality has executable parity evidence and no unsupported
capability is advertised as complete.

### Phase 4 — Continuous control

- Run scheduled live, stress, performance, mutation, and security checks.
- Review metrics monthly and ratchet warning/coverage thresholds.
- Smoke-test release artifacts on the supported platform matrix.

Exit: regression trends are visible before release and every release carries a
reproducible quality record.

## Interfaces and compatibility policy

Roadmap implementation must keep shared contracts additive. Future interface
work is expected in three internal boundaries:

1. exhaustive host/webview message unions with runtime validation;
2. a versioned persisted-grid-state envelope with legacy migration;
3. a versioned quality-report schema consumed by CI.

Removing or retyping an existing public field requires deprecation, consumer
migration, and compatibility tests. New platform-neutral behavior must remain
free of `vscode` imports.

## Maintenance rules

- Update this document when a baseline, priority, dependency, or acceptance
  criterion changes.
- Do not mark an item `done` solely because code was merged; attach passing
  verification and update affected documentation.
- Do not lower a threshold to make a regression pass. Record a time-bounded
  exception with owner, reason, and recovery item instead.
- Keep live credentials, customer SQL/data, screenshots, and generated reports
  out of source control.
- Re-audit the complete roadmap after a major architecture or product-scope
  change and at least once per release cycle.
