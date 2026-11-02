# Stage 4 — portability: import/export

Status: **implemented (2026-10-26) — automated checks green; maintainer round-trip between two real
installs pending.** Normative rules: `01-ranking-model.md` §5.

Scope:

- Versioned JSON document (`format: justybase-sql-knowledge`, `version: 1`, `exportedAt`,
  `relations`, `scores`, `objects`). No SQL text, literals, hosts, connection names, history, salts,
  fingerprints, execution keys, record ids or timestamps other than `exportedAt`.
- Only **active manual decisions** travel: relation `confirm`/`block`/`favorite`, non-zero score
  adjustments (`-5..+5`) and object `pin`/`boost`/`demote`/`exclude`. Observed evidence (workspace
  index, executed, accepted selections, column usage) is local by design and is never exported.
- Import is a transaction: whole-file validation (any invalid item rejects the file) → diff preview
  (added / unchanged / conflicting-with-manual) → explicit strategy `keep-local` (default) /
  `keep-import` / per-item → one atomic write (tmp + rename via the existing persistence) →
  one-step session undo. Unknown versions are rejected with zero writes.
- Decision histories from different installs are never concatenated: every applied item is a new
  local record (`import-…` id, `createdAt` = import time). A replaced local decision keeps its own
  chain (`revertedAt` + `replacedBy`).
- Explicit user-invoked commands only; no background sync, no team bundles in v1.

## Implementation record

| Part | Location |
|---|---|
| Pure export/parse/diff/apply | `packages/sql-core/src/joinKnowledge/portability.ts` |
| Service transaction + undo | `JoinKnowledgeService.exportKnowledge`, `previewImport`, `importKnowledge`, `undoLastImport` |
| Commands | `netezza.exportJoinKnowledge`, `netezza.importJoinKnowledge`, `netezza.undoJoinKnowledgeImport` (`src/commands/joinKnowledgePortabilityCommands.ts`) |

Behaviour details:

- The export is deterministic (sorted by canonical key) so two exports of the same state are
  byte-identical.
- Diff statuses compare the imported value with the active local one in the same class: decision
  (confirm/block), favorite, score, object preference. Local-only decisions are never removed.
- A failed write restores the in-memory state and reports that nothing changed.
- Undo restores the manual decision lists from before the import and keeps evidence recorded since
  then. It is refused once any manual decision was appended or reverted after the import; the
  manager's per-item undo remains available.
- Import files above 8 MB are rejected before parsing.

Tests: `packages/sql-core/__tests__/joinKnowledgePortability.test.ts` (payload-level privacy on the
exact exported bytes, determinism, unknown version/format/JSON rejection, whole-file rejection,
clean-profile round-trip, keep-local default, keep-import, per-item, no history concatenation),
`src/__tests__/knowledge/joinKnowledgeService.test.ts` (zero writes on rejection, single write,
undo keeping later evidence, undo refused after manual change, rollback on write failure),
`src/__tests__/knowledge/joinKnowledgePortabilityCommands.test.ts` (save/open dialogs, rejected
file, cancelled conflict choice).

Known gaps: no manager-view buttons yet (commands are in the Command Palette); a two-install
maintainer round-trip has not been recorded.
