# Stages 6–7 — AI discovery (sketch until Stage 5 gate passes, opt-in last)

Scope (when activated, in this order):

- Stage 6: explicit command `netezza.discoverJoinRelationships`. Bounded evidence packet (candidates +
  counters + provenance; no SQL, literals, hosts, credentials, history). Model counts discarded and
  overwritten with local counters. Strict schema validation, diff review (new/duplicate/conflicts/
  unverified-columns), per-item approve/reject, bulk "approve all non-conflicting". Approval writes
  `ai-approved` + promotes to `user-confirmed`; rejection stores a fingerprint so it is not resurfaced.
- Stage 7: on-demand agent tool `netezza_find_join_relationships` (package.json + contracts + tool impl +
  allowlist). Read-only, candidates for current SQL only, tagged `proposed`. Only if Stage 6 proved value.

Hard boundaries: AI is proposal-only, explicitly invoked per run, default off, consent-respecting.
No background calls. No object data sent to a model; no AI output can create/change/remove a
pin/boost/demote/exclude. Nothing (user, importer, AI) rewrites `justybase.sql.joinRelations` automatically.

Acceptance (when built): test 20 (+ privacy re-run on the exact evidence packet) and 21 green;
nothing persisted without approval; object preferences untouched by AI.
