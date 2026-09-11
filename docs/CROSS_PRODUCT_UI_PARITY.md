# Cross-product UI parity matrix

Last updated: 2026-09-11
Status: R9 in progress; the shared foundation, authenticated Electron shell,
and guarded Result Panel vertical slices are implemented, but full first-tier
parity is not complete.

This is the operational inventory for [R9 in the refactoring plan](REFACTORING_PLAN.md#r9-cautious-cross-product-ui-parity-rollout).
It records the ownership and behavior that a vertical slice must preserve
across the Web editor/API, the Electron development/test shell, and VS Code. Update the
affected row before extraction, after each adapter is wired, and when the
legacy fallback is removed.

`Current` identifies the implementation that owns behavior today. `Target`
identifies the R9 shared owner. A `legacy` row remains on the existing path;
`shared` is enabled only after the row's product gates pass. Product-specific
differences are intentional only when they are represented by a capability
descriptor and have an owner. The shared mode is opt-in (`legacy` remains the
default) while a slice is incomplete.

The status table below separates current implementation, R9 target, and
removal conditions. Electron currently exists only as a development/test shell;
it is not yet a complete product surface for every first-tier workflow.

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
  `npm run test:playwright:web-api` gate was then run with the managed browser
  on 2026-09-11 and passed (1 test, 3.8 s); the sandbox probe and the gate
  result are recorded separately.
- `@vscode/test-electron`: package version `3.1.0`; the Extension Host version
  remains the version reported by its managed download on the gate runner.

## Current, target, and status

`Current` columns describe the repository today. Electron has a development/
test shell and a shared editor bootstrap, but not every first-tier surface.
`Target` is the R9 owner after extraction. Status is per surface, not a claim
that the shared implementation already exists everywhere.

| Surface | Web/API current | Electron current | VS Code current | R9 target | Status | Capability owner / removal condition |
| --- | --- | --- | --- | --- | --- | --- |
| Shell and workspace tabs | `apps/web/src/App.tsx` and `SharedWebWorkspace` when enabled | `apps/electron/src/renderer/App.tsx` uses shared store/presentation | VS Code workbench and webviews | `@justybase/ui-core` + `@justybase/ui-react` | `shared` opt-in in Web/Electron; VS Code adapter-backed | R9 UI owner; remove legacy per product after tab identity, persistence, lifecycle, and browser/Extension Host gates. |
| SQL editor and LSP | Monaco in `apps/web`, API `sql-core` adapter | Shared editor shell and execution adapter; LSP wiring remains open | VS Code editor/LSP providers | Shared document ports + `sql-core` semantics | `adapter-backed` with shared shell composition; full parity pending | Editor/LSP owners; remove legacy after parser/completion, reconnect, and all-product authoring gates. |
| Connections | `workspacePanels.tsx` + API profile routes (including ephemeral password form state) | Main-owned authenticated session and redacted profile IPC | `ConnectionManager` + `SecretStorage` | Shared profile/auth ports; secrets remain adapter-owned | `shared` redacted bootstrap boundary; connection workflow remains adapter-backed | API/VS Code/Electron auth owners; remove legacy only after secret-boundary and auth tests pass. |
| Query execution and cancellation | `SharedWebWorkspace` maps API/WebSocket events to `ui-core` | Renderer execution adapter maps the authenticated API/WebSocket stream to `ui-core` | `StreamingManager` and desktop execution adapter | Shared execution state ports; runtime remains backend-owned | Web/Electron shared opt-in; VS Code adapter-backed | Execution owners; remove legacy after ordered-event, cancellation, reconnect, and no-duplicate-execution gates. |
| Result panel and Data Grid | `SharedWebWorkspace` uses shared result state/presentation | Shared editor, result tabs, grid, filtering, copy/export, and scroll state are wired through the renderer adapter | `media/resultPanel/sharedView.tsx` opt-in with legacy fallback | `@justybase/ui-core` + `@justybase/ui-react` result ports | `shared` opt-in in Web/Electron/VS Code; legacy defaults remain | Result Panel owner; remove legacy after identity/scroll, browser, Electron, Extension Host, and performance gates. |
| Schema navigation and metadata | Shared adapter maps API schema tree; legacy remains default | Capability is explicitly host-owned/unavailable in current shared Result Panel | metadata cache and schema tree | Shared explorer state + `metadata-core` | Adapter-backed; shared Result Panel capability-gated | Metadata owner; remove legacy after restart/invalidation and both SchemaProvider gates. |
| Query history | API `/api/history` + shared Web history state when enabled | Profile shell with explicit adapter-backed/unavailable capability | `QueryHistoryManager` uses `context.globalStorageUri`; `globalState` is legacy migration/fallback | Shared history view state; repository scope remains adapter-owned | Adapter-backed; shared Web composition includes an explicit pending state | History owner; remove legacy after scope/retention migration tests and all-product persistence gates. |
| Explain | Web `ExplainPanel` + API explain execution | Explicitly adapter-backed/pending | VS Code Explain command/webview path | Shared request/view state; provider plan parsing remains adapter-owned | Adapter-backed with capability state | Explain owner; remove legacy after dialect capability and cancellation/output fixtures pass. |
| Common designer workflows | Web `ObjectDesigner` + API guarded writes | Explicitly read-only/adapter-backed | Designer webviews/commands and companions | `designer-core` + shared React workflow components | Adapter-backed with explicit read-only capability | Designer/dialect owners; remove legacy per workflow after capability, preview-token, read-only, and packaging gates. |
| Import/export | Web panels/API routes | Not implemented | Workspace/temp-file and export services | Shared workflow state; format/filesystem ports | `platform-specific` in part; adapter-backed | Import/export owner; remove per-format legacy only after file sandbox, browser download, and companion gates. |
| Notebooks and advanced analysis | Partial/feature-specific Web paths | Not implemented | VS Code notebooks and desktop analysis views | Shared state only for portable contracts | `platform-specific` until capability is proven | Notebook/analysis owner; no removal until portable contract and lifecycle gates exist. |
| Administration and database operations | Web `AdminPanel`/guarded API subset | Not implemented | Provider-specific commands and panels | Capability-backed workflow state; operations remain adapter-owned | `platform-specific` by dialect/product | DBA/security owner; remove legacy only after authorization, audit, read-only, and live-provider evidence. |

## First-tier surfaces

The state and resource cells list the three products in this order: Web/API,
Electron, VS Code. The detailed rows below use the current/target/status table
above. The Electron renderer and the VS Code Result Panel can now opt into the shared
bundle, but the shared target remains incomplete until the corresponding slice
has passed all product gates.

| Surface | Product | State owner | Resource owner | Actions / shortcuts | Loading / empty / error / cancel | Persistence / identity | Capability / auth | Test | Known differences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shell and workspace tabs | Web/API shared composition (opt-in); Electron shared shell; VS Code current workbench/webview | Target: `@justybase/ui-core` workspace controller. | API session and browser storage; Electron main/profile; VS Code workspace and webview disposables. | Open/new/close/pin/reorder/switch; command-palette and product command mappings; exact key chords are adapter-owned and must be inventoried. | Shell initialization, no tabs, route failure, reconnect, and cancellation of a pending close/open operation. | User/workspace/profile plus stable document/tab identity; never tab index alone. | Authenticated Web session; Electron profile/loopback session; VS Code workspace, activation, and command permissions. | `ui-core` transition tests; Web shared adapter tests; Electron renderer/lifecycle tests; authoring Extension Host. | Browser navigation, native window lifecycle, and VS Code workbench ownership differ. |
| SQL editor and LSP authoring | Web/API; Electron; VS Code | Target: `ui-core` document/session state; `@justybase/sql-core` owns parser semantics; editor instances remain adapter-owned. | API LSP/metadata session; Electron loopback API; VS Code document, language server, and extension-host resources. | Run statement/query, explain, completion, format, rename, statement navigation, diagnostics, and cancel; preserve product-specific command IDs. | Editor/LSP readiness, empty document, malformed SQL, disconnected metadata, stale response, and cancelled request. | Document URI/path plus workspace/profile; no SQL result payload in UI persistence. | Dialect and LSP capability descriptors; Web auth/CSRF; VS Code language registration and workspace trust. | Parser/completion/parity tests; Web tests; authoring Extension Host; LSP smoke against controlled API. | Monaco and VS Code editor APIs have different provider and keybinding semantics. |
| Connections | Web/API; Electron; VS Code | Target: `ui-core` connection/profile state; adapters own credential and session projections. | API connection registry and secret/config boundary; Electron main process; VS Code `SecretStorage` and connection manager. | Connect/login, select profile, refresh metadata, disconnect, reconnect, and cancel initialization. | Connecting, no profiles, invalid credentials, unavailable driver, reconnect, cancellation, and clean disconnect. | Stable profile/connection identity; passwords and driver handles are never persisted in shared UI state. | API authorization and per-user ownership; Electron main-process secret boundary; VS Code secret storage and read-only capabilities. | Connection reducer/port tests; API auth tests; Electron start/stop; VS Code activation and live gates when configured. | Secret storage, profile scope, and available dialects differ by product. |
| Query execution and cancellation | Web/API; Electron; VS Code | Target: `ui-core` execution state keyed by execution identity; runtime owns execution lifecycle. | API query jobs/WebSockets and spool; Electron main API/runtime; VS Code `StreamingManager`, connections, and cancellation handles. | Run single/smart/batch query, run statement, continue-on-error where supported, explain, and cancel (`Esc`/`Ctrl/Cmd+Enter` mappings are adapter-owned). | Queued/running/streaming/partial/complete, empty result, error, reconnect, cancel-before-start/fetch/render/finalize. | Source, execution, result-set, and storage-session IDs remain distinct; one terminal state per execution. | Read-only/write capability, user authorization, dialect support, and API rate limits. | Execution contract tests; Web/API query tests; Extension Host result gate; Electron lifecycle/transport smoke; live DB only with variables. | Web transport and VS Code host callbacks differ; no second production execution path is allowed. |
| Result panel and Data Grid | Web/API; Electron; VS Code | Target: `@justybase/ui-core` result reducer plus `@justybase/ui-react`; current desktop grid remains `legacy` fallback. | API spool/session; Electron main API/runtime; VS Code host state, disk-backed storage, and webview bridge. | Switch result/log/source, pin/close, refresh/new execution, filter/search, sort, group, aggregate, pivot, row detail, copy/export, and guarded edit. | Logs-before-data, streaming, hydration, empty/zero-sized layout, partial/error, cancellation, hidden/revealed view, and missing-shell recovery. | Stable `resultSetId` with source/execution/storage identity; versioned grid/scroll envelopes and legacy read fallback. | User-scoped API results; Electron profile; VS Code workspace/webview ownership; read-only and guarded-write descriptors. | `npm run test:result-core`; Web grid tests; table-rendering Playwright; Extension Host result gate/repeat; data-grid benchmark/performance gate. | DOM/disk-backed desktop grid and React/TanStack web grid have different virtualization and page-depth behavior during migration. |
| Schema navigation and metadata | Web/API; Electron; VS Code | Target: `ui-core` explorer state; `@justybase/metadata-core` owns keys/merge/invalidation; tree rendering is shared. | API metadata/cache and DB session; Electron main API; VS Code metadata cache, prefetch, disk, and connection. | Expand/search/refresh, select object, insert name/column, drag to editor, inspect, top rows, copy name/DDL. | Initial load, partial snapshot, empty schema, stale/invalidation, authorization error, reconnect, and cancelled refresh. | User + connection + database/schema/object identity; generation/completeness prevents stale repopulation. | Object visibility, file/database access, dialect object types, and read-only policy. | Metadata restart/invalidation tests; both SchemaProviders; Web/API tests; Extension Host designer/schema smoke. | Catalog depth, drag/drop, DDL detail, and refresh controls vary by adapter. |
| Query history | Web/API shared composition (opt-in); Electron profile shell; VS Code current | Current: Web `HistoryPanel`/API; Electron history adapter is pending; VS Code `QueryHistoryManager`. Target: `ui-core` history state; product adapter owns query-history repository and retention. | API user-scoped history; Electron profile storage/API; VS Code `context.globalStorageUri` files and `globalState` legacy migration. | Search, open, favorite, rerun, copy, delete/clear; keybindings and command IDs require product inventory. | Loading, no history, corrupted entry, unauthorized entry, rerun failure, and cancellation. | User/profile scope plus execution/source fingerprint; VS Code history is extension-global in `globalStorageUri`, not workspace-scoped. Any scope migration requires an explicit versioned migration and retention review. | Authenticated owner checks and retention settings; read-only profile may browse but not rerun writes. | Web shared adapter tests; history reducer/port tests; Extension Host authoring/result smoke; Electron persistence test. | Web history is user-scoped, Electron profile-scoped, and VS Code extension-global today. |
| Explain | Web/API; Electron adapter pending; VS Code | Target: shared request/view state keyed by source and execution; provider-specific plan interpretation stays adapter-owned. | API query/explain job; Electron main API; VS Code provider connection and webview. | Explain active statement, cancel, switch source/result, copy/export plan where supported. | Preparing, empty plan, provider error, cancelled request, partial output, and reconnect. | Source/document plus execution identity; plan output may be cached only under an explicit versioned policy. | Dialect Explain capability, auth, read-only policy, and provider-specific output format. | Web ExplainPanel tests; SQL/LSP tests; Extension Host designer/authoring smoke; Electron adapter contract when enabled. | Graph/tuning visualizers and output formatting are not universally portable. |
| Common designer workflows | Web/API; Electron; VS Code | Target: `ui-core` workflow state + existing `designer-core` pure model; UI is `ui-react`; DDL/runtime effects are adapters. | API snapshot/write boundary; Electron main API/runtime; VS Code command/webview, connection, and secrets. | Create/alter table, index/partition workflows, preview/apply/confirm, refresh metadata, cancel, and close. | Capability unavailable, loading catalog, invalid draft, read-only, confirmation rejection, SQL error, cancel, and cleanup. | Draft/document identity plus target connection/object; no unconfirmed SQL or credentials in shared persistence. | Explicit dialect/designer capability, authorization, read-only guard, preview token, and confirmation. | `designer-core` tests; API/Web tests; `npm run test:extension-host:designer`; companion activation/build gates. | DDL syntax, supported objects, native dialogs, and guarded writes differ by dialect/product. |

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
| Foundation (`ui-core`, `ui-react`, adapters) | `legacy` default; `shared` opt-in | Implemented; Web shared composition is opt-in | Implemented development/test shell with authenticated main-owned session | Shared Result Panel adapter is opt-in; legacy fallback retained | Architecture, type, lint, lifecycle, contract, and coverage gates | R9 owner; keep the boundary secret-free and additive. |
| Results | `legacy` default until all three products pass | Shared Result Panel/Data Grid composition is opt-in | Authenticated shared editor/query/result composition is implemented in the renderer; default remains legacy | Shared Result Panel adapter is opt-in; legacy fallback retained | Result identity/scroll tests, Web/media/Electron coverage, browser and Extension Host evidence; Electron full product gate remains open | Result Panel owner; complete the remaining Electron/Web/VS Code parity matrix before changing the default. |
| Workspace/authoring | `legacy` until authoring matrix passes | Shared shell/document/execution composition is opt-in; legacy remains default | Shared editor shell is present; API/LSP and execution wiring remain open | Existing editor/LSP semantics and host ownership remain | LSP/completion/parity, authoring Extension Host, reconnect, and persistence tests | SQL/editor owners; preserve public commands. |
| Schema/designers | `legacy` per surface | Schema state is adapter-backed in shared Web composition | Explicit capability/adapter-backed state | Existing designer/companion paths | Designer, capability, guarded-write, metadata-refresh, and packaging gates | Designer/metadata owners; document dialect exceptions. |

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
