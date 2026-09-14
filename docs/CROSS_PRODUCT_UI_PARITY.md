# Cross-product UI parity matrix

Last updated: 2026-09-13
Status: Dockyard is the production/default shell for Web and Electron and is
verified locally with the controlled Chromium/API workflow. The cross-platform
matrix is committed for Linux, Windows, and macOS; platform-specific evidence
is tracked by CI. Web and Electron have separate Dockyard composition roots,
while VS Code keeps its host-owned renderer.

This is the operational inventory for the Web/Electron Dockyard workspaces and
their VS Code adapter boundary. Historical R9/R10 extraction decisions remain
in [the refactoring plan](REFACTORING_PLAN.md); the earlier Shared Web rollout
is historical rather than the current composition contract. This document
records the ownership and behavior that a vertical slice must preserve across
the Web editor/API, Electron, and VS Code.

`Current` identifies the implementation that owns behavior today. `Target`
identifies the portable shared owner or the intentionally host-owned boundary.
Product-specific differences are intentional only when they are represented
by a capability descriptor and have an owner. The Web production entrypoint
always mounts `DockyardWorkspace`, while Electron mounts
`ElectronDockyardWorkspace`; each composition root owns its DOM and lifecycle.
VS Code keeps its existing host path. There is no production `VITE_UI_MODE`
switch or shared-renderer rollback path.

Workspace persistence is a versioned, product-scoped envelope containing only
document metadata/content, document order, active document, connection
context, and the Dockyard layout snapshot. Legacy `tabs` and older Web keys
migrate into that envelope; SQL credentials, result rows, DOM nodes, and
runtime handles are excluded.

The status table below separates current implementation, R9 target, and
removal conditions. Electron remains a development/test shell rather than a
packaged product, but its authenticated renderer now exercises the shared
first-tier workspace, results, schema, history, Explain, designer, and
import/export workflows through the real loopback API.

## Baseline environment

- Node: `v24.13.1`
- npm: `11.18.0`
- Host: Linux WSL2 (`x86_64`)
- VS Code: `1.137.0`
- Playwright: version `1.62.1`; the managed Chromium executable was detected
  at `chromium-1234` and reports Chrome for Testing `151.0.7922.34`.
- Browser launch probe: attempted, but the current sandbox rejected Chromium's
  sandbox host with `Operation not permitted`; this is a failed local probe,
  not evidence that the managed browser is unavailable. The deterministic
  `npm run test:playwright:web-shared` gate was then run with the managed browser
  on 2026-09-13 and passed locally; the sandbox probe and the gate
  result are recorded separately.
- Electron real-window smoke: `npm run test:electron:live` passed on
  2026-09-12 with an isolated SQLite fixture, shared Monaco authoring checks,
  Object Designer preview/apply, schema refresh, DDL, 1,200-row result-grid
  paging/filtering, aggregate analysis, vertical and horizontal scroll
  restoration, clipboard, CSV, and CSV gzip export checks. The report contained
  11 checks and no credentials or row values. The aggregate action was verified
  through the same shared grid/panel path used by the Electron renderer.
- Result-panel Extension Host evidence: `npm run test:extension-host` passed on
  2026-09-12 with 3 result sets, 11 trace phases, and restoration of
  `scrollTop=1800`, `scrollLeft=320`, and the exact virtual anchor row 63 after
  Logs/source switching. The dedicated
  `npm run test:extension-host:filter-performance` gate also passed for a
  4,000 x 32 fixture: filter latency `200.2–200.6 ms`, ascending/descending
  sort `39/20.7 ms`, and scroll restoration at `scrollTop=9000`,
  `scrollLeft=320`, `anchorRow=363`.
- Browser Data Grid evidence: `npm run test:playwright:data-grid-performance`
  passed 6/6 in 53.1 s, and the rendering complement passed 19/19 in 20.9 s.
  These gates cover the legacy/shared renderer comparison, worker cold/warm
  filtering, rapid-query coalescing, sorting, export preparation, virtual
  scrolling, persistence, grouping, hidden views, and out-of-order stream
  recovery.
- Shared visual evidence: `npm run test:playwright:data-grid-visual` passed in
  the controlled 1280×720 Chromium viewport and created deterministic initial
  and interactive Data Grid baselines. The fixture contains 10,000 rows,
  typed values, NULL, filtering, grouping, pinning, selection, and horizontal
  scrolling. The renderer is the same `@justybase/ui-react` DataGrid used by
  Web and Electron.
- Build serialization evidence: `npm run test:workspace-build-graph` passed
  with two concurrent Web build processes; the workspace lock serialized the
  graph and left no stale lock behind.
- Dockyard Web cross-platform gate: `.github/workflows/web-shared.yml` runs the
  real `npm run test:playwright:web-dockyard` Chromium/API scenario on Linux,
  Windows, and macOS. The local Linux run is the current proof point;
  platform-specific evidence is collected by the matrix.
- `@vscode/test-electron`: package version `3.1.0`; the Extension Host version
  remains the version reported by its managed download on the gate runner.

## Current, target, and status

`Current` columns describe the repository today. Electron has a development/
test Dockyard shell and a separate editor composition, but not every first-tier
surface.
`Target` is the shared owner after extraction. Status is per surface, not a
claim that VS Code must adopt the Web renderer.

| Surface | Web/API current | Electron current | VS Code current | R9 target | Status | Capability owner / removal condition |
| --- | --- | --- | --- | --- | --- | --- |
| Shell and workspace tabs | `DockyardWorkspace` with durable document persistence and stable source identities | `ElectronDockyardWorkspace` with Electron-owned content/lifecycle composition | VS Code workbench and webviews | `@justybase/ui-core` + `@justybase/ui-react`; Dockyard layout remains product-owned | Separate Web/Electron Dockyard roots; VS Code adapter-backed | Shared workspace owner; retain platform-specific shell differences only behind explicit capability boundaries. |
| SQL editor and LSP | Monaco in `DockyardWorkspace`, `@justybase/ui-monaco`, API `sql-core` adapter | Electron-owned Dockyard composition with shared Monaco/result primitives, dialect profile, completion and execution adapter | VS Code editor/LSP providers | Shared document ports + `sql-core` semantics; browser Monaco boundary is `ui-monaco` | Web/Electron authoring share logic, not a DOM shell; VS Code path remains separate | Editor/LSP owners; dialect and host-specific authoring differences stay adapter-owned. |
| Connections | `workspacePanels.tsx` + API profile routes (including ephemeral password form state) | Main-owned authenticated session and redacted profile IPC | `ConnectionManager` + `SecretStorage` | Shared profile/auth ports; secrets remain adapter-owned | `shared` redacted bootstrap boundary; connection workflow remains adapter-backed | API/VS Code/Electron auth owners; remove legacy only after secret-boundary and auth tests pass. |
| Query execution and cancellation | `DockyardWorkspace` maps API/WebSocket events through the shared execution controller | `ElectronDockyardWorkspace` maps the authenticated API/WebSocket stream through its Electron adapter | `StreamingManager` and desktop execution adapter | Shared execution state ports; runtime remains backend-owned | Separate Web/Electron Dockyard roots; VS Code adapter-backed | Execution owners; ordered events, cancellation, reconnect, and cleanup remain required gates. |
| Result panel and Data Grid | `DockyardWorkspace` uses the shared result panel/Data Grid with per-document result identity | Electron-owned Dockyard composition wires the same editor, result tabs, grid, filtering, copy/export, grouping drop zone, and scroll state | `media/resultPanel/sharedView.tsx` opt-in with legacy fallback | `@justybase/ui-core` + `@justybase/ui-react` result ports and canonical token stylesheet | Web/Electron share the canonical Data Grid; VS Code adapter-backed | Result Panel owner; retain host-specific virtualization only where capability requires it. |
| Schema navigation and metadata | Dockyard Web adapter maps API schema tree, database context and inspector | Authenticated Dockyard schema tree, search, columns, DDL, top rows, import and designer entry points | metadata cache and schema tree | Shared explorer state + `metadata-core` | Web/Electron adapter-backed; VS Code remains host-owned | Metadata owner; preserve restart/invalidation and SchemaProvider gates. |
| Query history | Dockyard Web history view backed by API `/api/history` | Authenticated profile-scoped history view with open, copy, refresh and rerun actions | `QueryHistoryManager` uses `context.globalStorageUri`; `globalState` is legacy migration/fallback | Shared history view state; repository scope remains adapter-owned | Web presentation; Electron adapter slice is wired | History owner; scope/retention remains product-owned. |
| Explain | Web `ExplainPanel` + API explain execution | Authenticated Explain view backed by the shared execution/API adapter | VS Code Explain command/webview path | Shared request/view state; provider plan parsing remains adapter-owned | Adapter-backed with an available Electron capability | Explain owner; remove legacy after dialect capability and cancellation/output fixtures pass. |
| Common designer workflows | Web `ObjectDesigner` + API guarded writes | Shared React Object Designer with guarded preview/apply and metadata refresh | Designer webviews/commands and companions | `designer-core` + shared React workflow components | Adapter-backed; guarded SQLite slice is live-tested and capability-described | Designer/dialect owners; remove legacy per workflow after capability, preview-token, read-only, and packaging gates. |
| Import/export | Web panels/API routes | Shared import panel and authenticated CSV/CSV gzip/result-download adapter | Workspace/temp-file and export services | Shared workflow state; format/filesystem ports | Adapter-backed for guarded import and result export in the development/test shell | Import/export owner; remove per-format legacy only after file sandbox, browser download, and companion gates. |
| Notebooks and advanced analysis | Shared Result Grid aggregate/group/pivot analysis; notebooks and charts unavailable | Shared Result Grid aggregate/group/pivot analysis is live-tested; notebooks are not implemented | Shared Result Panel aggregate/group/pivot analysis is opt-in; VS Code notebooks and desktop analysis views remain host-owned | Shared analysis state only for portable tabular operations; notebook/chart lifecycle remains product-owned | `adapter-backed` for aggregate/group/pivot result analysis; notebooks remain `platform-specific` | Analysis owner; expose unavailable capabilities explicitly. |
| Administration and database operations | Web `AdminPanel`/guarded API subset | Not implemented | Provider-specific commands and panels | Capability-backed workflow state; operations remain adapter-owned | `platform-specific` by dialect/product | DBA/security owner; remove legacy only after authorization, audit, read-only, and live-provider evidence. |

## First-tier surfaces

The state and resource cells list the three products in this order: Web/API,
Electron, VS Code. The detailed rows below use the current/target/status table
above. Web and Electron use separate Dockyard roots around shared portable
state and result/editor primitives; the VS Code Result Panel can independently
opt into the shared bundle. The shared target remains incomplete until each
corresponding slice has passed all product gates.

| Surface | Product | State owner | Resource owner | Actions / shortcuts | Loading / empty / error / cancel | Persistence / identity | Capability / auth | Test | Known differences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shell and workspace tabs | Separate `DockyardWorkspace` and `ElectronDockyardWorkspace` compositions with durable documents; VS Code current workbench/webview | Target: `@justybase/ui-core` workspace controller. | API session and browser storage; Electron main/profile; VS Code workspace and webview disposables. | Open/new/close/pin/reorder/switch; command-palette and product command mappings; exact key chords are adapter-owned and must be inventoried. | Shell initialization, no tabs, route failure, reconnect, and cancellation of a pending close/open operation. | User/workspace/profile plus stable document/tab identity; never tab index alone. | Authenticated Web session; Electron profile/loopback session; VS Code workspace, activation, and command permissions. | `ui-core` transition tests; Web Dockyard adapter tests; Electron renderer/lifecycle tests; authoring Extension Host. | Browser navigation, native window lifecycle, and VS Code workbench ownership differ. |
| SQL editor and LSP authoring | Web/API; Electron; VS Code | Target: `ui-core` document/session state; `@justybase/sql-core` owns parser semantics; editor instances remain adapter-owned. | API LSP/metadata session; Electron loopback API; VS Code document, language server, and extension-host resources. | Run statement/query, explain, completion, format, rename, statement navigation, diagnostics, and cancel; preserve product-specific command IDs. | Editor/LSP readiness, empty document, malformed SQL, disconnected metadata, stale response, and cancelled request. | Document URI/path plus workspace/profile; no SQL result payload in UI persistence. | Dialect and LSP capability descriptors; Web auth/CSRF; VS Code language registration and workspace trust. | Parser/completion/parity tests; Web tests; authoring Extension Host; LSP smoke against controlled API. | Monaco and VS Code editor APIs have different provider and keybinding semantics. |
| Connections | Web/API; Electron; VS Code | Target: `ui-core` connection/profile state; adapters own credential and session projections. | API connection registry and secret/config boundary; Electron main process; VS Code `SecretStorage` and connection manager. | Connect/login, select profile, refresh metadata, disconnect, reconnect, and cancel initialization. | Connecting, no profiles, invalid credentials, unavailable driver, reconnect, cancellation, and clean disconnect. | Stable profile/connection identity; passwords and driver handles are never persisted in shared UI state. | API authorization and per-user ownership; Electron main-process secret boundary; VS Code secret storage and read-only capabilities. | Connection reducer/port tests; API auth tests; Electron start/stop; VS Code activation and live gates when configured. | Secret storage, profile scope, and available dialects differ by product. |
| Query execution and cancellation | Web/API; Electron; VS Code | Target: `ui-core` execution state keyed by execution identity; runtime owns execution lifecycle. | API query jobs/WebSockets and spool; Electron main API/runtime; VS Code `StreamingManager`, connections, and cancellation handles. | Run single/smart/batch query, run statement, continue-on-error where supported, explain, and cancel (`Esc`/`Ctrl/Cmd+Enter` mappings are adapter-owned). | Queued/running/streaming/partial/complete, empty result, error, reconnect, cancel-before-start/fetch/render/finalize. | Source, execution, result-set, and storage-session IDs remain distinct; one terminal state per execution. | Read-only/write capability, user authorization, dialect support, and API rate limits. | Execution contract tests; Web/API query tests; Extension Host result gate; Electron lifecycle/transport smoke; live DB only with variables. | Web transport and VS Code host callbacks differ; no second production execution path is allowed. |
| Result panel and Data Grid | Web/API; Electron; VS Code | Target: `@justybase/ui-core` result reducer plus `@justybase/ui-react`; Web and Electron use the canonical React Data Grid while VS Code retains its host renderer. | API spool/session; Electron main API/runtime; VS Code host state, disk-backed storage, and webview bridge. | Switch result/log/source, pin/close, refresh/new execution, filter/search, sort, group, aggregate, pivot, row detail, copy/export, and guarded edit. | Logs-before-data, streaming, hydration, empty/zero-sized layout, partial/error, cancellation, hidden/revealed view, and missing-shell recovery. | Stable `resultSetId` with source/execution/storage identity; versioned grid/scroll envelopes and legacy read fallback; Web/Electron adapters persist view and scroll state in product-owned storage. | User-scoped API results; Electron profile; VS Code workspace/webview ownership; read-only and guarded-write descriptors. | `npm run test:result-core`; Web grid tests; table-rendering Playwright; Extension Host result gate/repeat; Electron live smoke; data-grid benchmark/performance gate. | Web/Electron use the canonical React grid; VS Code's host renderer has different virtualization and page-depth behavior. |
| Schema navigation and metadata | Web/API; Electron; VS Code | Target: `ui-core` explorer state; `@justybase/metadata-core` owns keys/merge/invalidation; tree rendering is shared. | API metadata/cache and DB session; Electron main API; VS Code metadata cache, prefetch, disk, and connection. | Expand/search/refresh, select object, insert name/column, drag to editor, inspect, top rows, copy name/DDL. | Initial load, partial snapshot, empty schema, stale/invalidation, authorization error, reconnect, and cancelled refresh. | User + connection + database/schema/object identity; generation/completeness prevents stale repopulation. | Object visibility, file/database access, dialect object types, and read-only policy. | Metadata restart/invalidation tests; both SchemaProviders; Web/API tests; Extension Host designer/schema smoke; Electron live schema/DDL/designer smoke. | Catalog depth, drag/drop, DDL detail, and refresh controls vary by adapter. |
| Query history | Dockyard Web composition; Electron profile shell; VS Code current | Current: Dockyard Web history/API; Electron authenticated history adapter; VS Code `QueryHistoryManager`. Target: `ui-core` history state; product adapter owns query-history repository and retention. | API user-scoped history; Electron profile storage/API; VS Code `context.globalStorageUri` files and `globalState` legacy migration. | Search, open, favorite, rerun, copy, delete/clear; keybindings and command IDs require product inventory. | Loading, no history, corrupted entry, unauthorized entry, rerun failure, and cancellation. | User/profile scope plus execution/source fingerprint; VS Code history is extension-global in `globalStorageUri`, not workspace-scoped. Any scope migration requires an explicit versioned migration and retention review. | Authenticated owner checks and retention settings; read-only profile may browse but not rerun writes. | Web Dockyard adapter tests; history reducer/port tests; Extension Host authoring/result smoke; Electron live history smoke. | Web history is user-scoped, Electron profile-scoped, and VS Code extension-global today. |
| Explain | Web/API; Electron; VS Code | Target: shared request/view state keyed by source and execution; provider-specific plan interpretation stays adapter-owned. | API query/explain job; Electron main API; VS Code provider connection and webview. | Explain active statement, cancel, switch source/result, copy/export plan where supported. | Preparing, empty plan, provider error, cancelled request, partial output, and reconnect. | Source/document plus execution identity; plan output may be cached only under an explicit versioned policy. | Dialect Explain capability, auth, read-only policy, and provider-specific output format. | Web ExplainPanel tests; SQL/LSP tests; Extension Host designer/authoring smoke; Electron live Explain/transport smoke. | Graph/tuning visualizers and output formatting are not universally portable. |
| Common designer workflows | Web/API; Electron; VS Code | Target: `ui-core` workflow state + existing `designer-core` pure model; UI is `ui-react`; DDL/runtime effects are adapters. | API snapshot/write boundary; Electron main API/runtime; VS Code command/webview, connection, and secrets. | Create/alter table, index/partition workflows, preview/apply/confirm, refresh metadata, cancel, and close. | Capability unavailable, loading catalog, invalid draft, read-only, confirmation rejection, SQL error, cancel, and cleanup. | Draft/document identity plus target connection/object; no unconfirmed SQL or credentials in shared persistence. | Explicit dialect/designer capability, authorization, read-only guard, preview token, and confirmation. | `designer-core` tests; API/Web tests; `npm run test:extension-host:designer`; Electron live designer/schema smoke; companion activation/build gates. | DDL syntax, supported objects, native dialogs, and guarded writes differ by dialect/product. |

## Second-tier surfaces

These rows are not allowed to become silently missing during parity work. A
product either adopts the shared boundary or renders the named capability state
and points to its adapter owner and removal condition.

| Surface | Product | State owner | Resource owner | Actions / shortcuts | Loading / empty / error / cancel | Persistence / identity | Capability / auth | Test | Known differences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Import and export | Web/API; Electron; VS Code | Target: shared workflow state; format-specific options stay adapter-backed. | API upload/export job and sandbox; Electron main filesystem; VS Code workspace/temp files and export services. | Import CSV/XLSX, preview/confirm, export CSV/XLSX/XLSB/Parquet/Markdown, cancel, and reveal/open where supported. | File selection, parse preview, empty file, invalid format, unauthorized path, partial export, cancel, cleanup. | File/job identity and result-set identity; never persist file contents or credentials as UI state. | File sandbox, browser download, Electron filesystem, VS Code workspace trust, format/dialect support. | Import/export integration tests; API/Web tests; companion/package and Extension Host export smoke. | Browser download replaces native open; XLSB/Excel and filesystem operations need capability descriptors. |
| Notebooks and advanced analysis | Web/API; Electron; VS Code | Target: shared notebook/analysis state only where contracts are portable; otherwise explicit capability. | API execution/session store; Electron main API; VS Code notebook controllers, result storage, and webviews. | Create/run/cancel cell, reorder, save/open, chart/card/range analysis, copy/export. | Loading cell, empty notebook, stale execution, partial output, failed cell, cancel, reconnect. | Notebook/document identity plus per-cell execution/result IDs; no duplicate production execution for comparison. | Notebook registration, chart/analysis support, auth, and dialect capabilities. | Notebook/analysis controller tests; Web smoke; VS Code notebook/Extension Host; Electron smoke when enabled. | VS Code notebook APIs and desktop analysis cards are not browser-equivalent by default. |
| Administration and database operations | Web/API; Electron; VS Code | Target: capability-backed workflow state; provider-specific operations remain adapter-owned. | API authorization/audit and DB runtime; Electron main process; VS Code commands, secrets, and provider sessions. | Security/session monitor, comments, permissions, maintenance, rename/drop/truncate, tuning, and owner/recreate/skew actions. | Capability unavailable, catalog load, preview, confirmation rejection, read-only, SQL error, cancel, audit failure. | Target connection/object identity and audited operation ID; no durable secrets or unconfirmed statements in shared state. | Strong auth, read-only guard, exact preview token, dialect capability, audit requirement. | Negative security tests; API guarded-write tests; live/companion gates; Extension Host designer/command smoke. | Many operations are intentionally VS Code/dialect-specific until portable contracts and authorization exist. |

## Slice status and removal record

| Slice | Flag/default | Web | Electron | VS Code | Legacy removal evidence | Owner / next condition |
| --- | --- | --- | --- | --- | --- | --- |
| Foundation (`ui-core`, `ui-react`, adapters) | Dockyard roots are separate per product; portable state/ports and the model adapter are shared | Implemented production Web Dockyard composition | Implemented Electron Dockyard composition with authenticated main-owned session | Shared Result Panel adapter is opt-in; legacy fallback retained | Architecture, type, lint, lifecycle, contract, coverage, and Electron live-window gates | Shared owner; keep the boundary secret-free and additive. |
| Results | Dockyard Web/Electron defaults; VS Code host renderer remains separate | Dockyard Web result panel/Data Grid composition is the default | Electron Dockyard result panel/Data Grid composition is the default | Shared Result Panel adapter is opt-in; legacy fallback retained | Result identity/scroll tests, canonical result-state coverage, Web/media/Electron coverage, browser and Extension Host evidence, and passed Electron live-window smoke | Result Panel owner; preserve explicit platform capability differences. |
| Workspace/authoring | Separate Web/Electron Dockyard roots; portable state and SQL semantics are shared | Dockyard Web shell/document/execution composition is the production path | Electron Dockyard shell/document/execution composition is the production path | Existing editor/LSP semantics and host ownership remain | LSP/completion/parity, authoring Extension Host, reconnect, and persistence tests | SQL/editor owners; preserve public commands. |
| Schema/designers | `legacy` per surface | Schema state is adapter-backed in Dockyard Web composition | Available guarded metadata/designer capability in the Electron Dockyard shell | Existing designer/companion paths | Designer, capability, guarded-write, metadata-refresh, live SQLite, and packaging gates | Designer/metadata owners; document dialect exceptions. |
| Historical Shared Web renderer | No production flag; fixture only | Not used by Web production | Not used by Electron | VS Code host/workbench remains product-owned | Dockyard Web/Electron browser and lifecycle gates | Keep the fixture only for portable reducer/presentation coverage; do not reintroduce it as a production shell. |

## Update rules

- Change a row's status only with a linked test artifact or gate result; a
  skipped live, Windows, Remote-WSL, browser, Electron, or Extension Host
  environment is not a pass.
- Keep state ownership separate from resource ownership. A renderer may hold
  view state, but adapters own connections, timers, workers, sockets, storage,
  temporary files, and shutdown.
- Preserve additive HTTP, WebSocket, webview, companion, and persistence
  contracts. Use explicit version migrations and stable identities; do not
  restore state for another user, product, source, or result set.
- Remove a legacy row only after the same characterization fixtures pass in
  Web, Electron, and VS Code and the negative/security/lifecycle gates are
  recorded.
