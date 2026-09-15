# Dockyard Web and Electron workspace

The production Web and Electron workspaces use Dockyard as their shell. They
intentionally have separate composition roots: the products share portable
state, persistence, API contracts, Monaco/result primitives, and the Dockyard
model adapter, but each product owns its DOM composition and lifecycle.

## Composition boundary

```text
Web App.tsx
  -> apps/web/src/dockyard/DockyardWorkspace.tsx
     -> apps/web/src/dockyard/dockyardManagerAdapter.ts

Electron renderer App.tsx
  -> apps/electron/src/renderer/dockyard/ElectronDockyardWorkspace.tsx
     -> @justybase/dockyard-layout

Both products
  -> @justybase/dockyard-layout
     -> avalondock-web + contracts + ui-core
  -> ui-monaco / ui-react / api-client
```

`@justybase/dockyard-layout` owns the platform-neutral Dockyard boundary:
stable content IDs, safe default layout, persistence envelopes, snapshot
validation/normalization, context-menu policy, model synchronization, and
teardown. Web storage and Electron storage are injected by their product
adapters and use different identities, so a browser layout cannot overwrite an
Electron layout.

The vendored Dockyard surface is pinned to upstream `0.1.0` at commit
`921b9a66cac88b07af6edb3ebd5cd47af500c900`. The product adapter rejects
unsupported browser-window actions, ignores corrupt/foreign/future snapshots,
and restores a safe in-memory layout when persistence is unavailable.

The old `SharedWebWorkspace` remains only as a component-test fixture for
portable reducer/presentation tests. It is not selected by the production Web
composition root.

## Result grid decision

The current integrated `@justybase/ui-react` `DataGrid` remains the product
grid for both Web and Electron. This preserves the tested result contract:
virtual rows and columns, selection, filtering, sorting, grouping, pinned
columns, row/cell context actions, row details, aggregates, pivot/group
analysis, scroll restoration, streaming/page hydration, and export controls.

`TreeDataGridWeb` is not adopted in this migration. It is a candidate for a
separate spike only after it can pass the existing result-panel contract and
performance gates for both products; switching grids while changing the shell
would make failures difficult to attribute.

## Verification gates

Run the following from the repository root after changing the shell, shared
adapter, schema tools, editor, or result grid:

```bash
npm run check-types:web
npm run check-types:only --workspace @justybase/electron-shell
npm run test:web -- --runInBand
npm run test:electron
npm run test:playwright:web-dockyard
npm run build:all
```

`test:playwright:web-dockyard` builds the test Web bundle, starts an isolated
API/SQLite fixture on port 3010, and verifies:

- authentication, connection creation, query execution, result rows, history;
- Monaco focus and authoring completion for multiple dialects;
- SQL Problems, parser quick actions, and result/Problems switching;
- Dockyard document reorder, dirty-close confirmation, float/dock,
  auto-hide/pin, reload persistence, reset/recovery, and snapshot hygiene;
- schema search, object context menu, reconstructed DDL copy/open, designer
  preview/apply, schema refresh, and import entry points;
- virtual result rows, server filtering, horizontal/vertical scroll anchors,
  cell/row actions, row details, and CSV export.

The compatibility alias `test:playwright:web-shared` points to the Dockyard
gate so CI and local scripts do not silently exercise the retired production
shell.

## Manual visual checklist

The manual development server is available at
`http://127.0.0.1:5173/`. Use a controlled SQLite profile first, then a
Netezza profile when credentials are available.

1. Confirm the dark Dockyard shell, top bar, Schema pane, document tab, editor
   toolbar, Results/Problems output, status bar, and readable explorer width.
2. Create two SQL tabs; edit one, reorder tabs, float/dock it, auto-hide Schema,
   pin it again, reload, and verify the layout and dirty markers persist.
3. In Schema, use search and the object context menu for top rows, Explain,
   Copy DDL, Open DDL, Object Designer, Import CSV/XLSX, and refresh. After
   selecting a table, also verify that **Import data** is available in the
   main bar in both Web and Electron.
4. In Monaco, verify completion, hover/diagnostics, Problems selection, code
   action/quick fix, dialect switching, and the editor remains focused after a
   result or tool is activated.
5. In Results, verify streaming/page loading, filter/sort, column filter,
   grouping/aggregate/pivot, selection/context menu, row details, copy, and
   CSV/XLSX export. Repeat the same checks in Electron.

When a visual issue is found, record the viewport, active Dockyard tool,
document/result identity, persisted layout key, and whether the issue occurs
after reload. Do not use real credentials or upload screenshots containing
Netezza data.
