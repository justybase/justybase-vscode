# Webview UX Conventions

Last updated: 2026-06-12

This document defines the baseline UX contract for extension webviews. Phase 5 adds typed extension-host message contracts and sync tests for high-traffic panels, but the frontend implementation remains plain JavaScript for now.

## Purpose

The goal is consistency, not uniformity for its own sake. Every webview does not need the same layout, but every high-traffic panel should make async work, no-data states, failures, cancellation, and keyboard interaction predictable.

## Required conventions

### Loading state

Use a visible loading affordance whenever data is being fetched, streamed, refreshed, or recalculated.

Required behavior:

1. Show a spinner, skeleton, or progress label while async work is active.
2. Keep the current view stable when possible instead of blanking the entire panel.
3. Disable only the actions that are unsafe during the active operation.
4. Distinguish first-load loading from refresh loading when the panel already has data.

### Empty state

Use an explicit empty state when a panel has no data yet or no results match the current filter.

Required behavior:

1. Show a short, user-facing explanation of why the panel is empty.
2. Prefer one follow-up hint or action over generic filler text.
3. Reuse a consistent visual pattern such as `.empty-state` with an icon and short message.

### Error state

Errors should be visible in the webview when the user can continue working in that panel.

Required behavior:

1. Show the error inline when the user needs context inside the panel.
2. Keep retry local when retry is meaningful.
3. Reserve host-level `showErrorMessage(...)` popups for destructive failures or failures that affect the wider extension.

### Cancelled state

Cancellation is not the same as failure and should not be presented as failure.

Required behavior:

1. Preserve any valid partial data if it is still useful.
2. Show a clear cancelled message when the user initiated the stop.
3. Keep retry or rerun nearby when the workflow is repeatable.

### Keyboard

Keyboard support should be deliberate for high-traffic panels, not accidental.

Required behavior:

1. Tab order must reach primary controls and any open menus or dialogs.
2. `Escape` should close transient UI such as menus, popovers, and dialogs when applicable.
3. `Enter` should submit search or filter inputs where that matches the panel model.
4. `Cmd+C` or `Ctrl+C` should copy current selection when the panel supports grid or text selection.

## Message contract rule

For panels with typed host-side message contracts:

1. Update the shared contract in `src/contracts/webviews/` when a message command or payload changes.
2. Keep the webview sync test passing for the changed panel.
3. Review the affected panel against the conventions in this document if the change alters loading, empty, error, or cancellation behavior.

## Shared patterns already in use

These are the current patterns worth standardizing instead of re-inventing panel by panel:

1. `loading-overlay` plus `.visible` toggle for blocking refresh states.
2. `.empty-state` blocks with a short icon-and-text treatment.
3. Status surfaces such as `setLoading`, `setError`, or local status text containers.
4. Tab-strip state driven by active class toggles and hidden content panes.

## Baseline audit

Status values:

1. `present`: explicit implementation exists.
2. `partial`: behavior exists but is incomplete or inconsistent.
3. `missing`: no explicit handling found.
4. `n/a`: state does not materially apply to the panel.
5. `unknown`: panel needs a deeper inspection before standardizing.

| Panel | Loading | Empty | Error | Cancelled | Keyboard | Notes |
|-------|---------|-------|-------|-----------|----------|-------|
| Result Panel | present | present | present | present | partial | Uses overlay, result/log empty states, inline error result handling, cancellation flow, and partial grid keyboard behavior. |
| Login Panel | n/a | n/a | partial | n/a | partial | Form validation exists and the host-side message contract is now typed, but loading and recovery UX remain lightweight. |
| Query History | present | present | partial | partial | partial | Uses a loading indicator, explicit empty state, and search interaction, but cancellation and retry remain implicit. |
| ETL Designer | partial | missing | missing | present | missing | Cancellation exists in workflow code, but panel-level empty, loading, and error UX is still thin. |
| Schema Search | present | present | partial | present | partial | Initial and no-results empty states, result count, cancelled search preserves partial results, min-length validation, and Enter/Space on standard list rows. |
| Session Monitor | present | present | present | n/a | n/a | Strongest dashboard-style implementation after Result Panel, with explicit loading, empty sections, and error messages. |
| Test Data Generator | partial | present | partial | missing | partial | Uses generation flow affordances and some empty feedback, but state transitions are not yet standardized. |
| Edit Data | present | present | present | partial | present | Strong data-entry panel with explicit loading/error handling and useful keyboard support. |
| Security Panel | present | partial | present | missing | partial | Has loading and error signaling, but empty and keyboard coverage are still incomplete. |
| Visual Query Builder | present | partial | present | missing | present | Async and error states exist, and some keyboard handling is deliberate, but empty-state semantics are still weak. |
| ERD View | n/a | partial | n/a | n/a | n/a | Mostly static visualization; has some no-data feedback but little async/error state machinery. |
| Explain Plan | partial | present | partial | n/a | n/a | Shared contracts; empty graph card when no nodes are available. |
| Schema Compare | n/a | n/a | n/a | n/a | n/a | Primarily static comparison rendering with limited async interaction. |
| Query Flow | n/a | partial | n/a | n/a | present | Interactive visualization has some keyboard affordance, but limited formal state handling. |
| Table Designer | partial | present | present | present | n/a | Shared contracts plus inline validation banner, empty-columns card, and host error feedback. |
| Analysis Panel | missing | present | partial | missing | present | Empty instructional states are clear, but loading/cancel/error behavior is still ad hoc. |
| Copilot Profiles | partial | partial | present | n/a | n/a | Async profile load and error reporting exist, but empty/loading behavior is not yet standardized. |

## Phase 5 focus

Phase 5 standardizes typed host-side contracts for the highest-traffic and lowest-cost webview panels completed so far:

1. Result Panel
2. Query History
3. Session Monitor
4. Login Panel

The remaining panels should adopt the same message-contract pattern incrementally instead of waiting for a full frontend rewrite.