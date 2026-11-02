# Stage 1 — foundation and regressions (implements first)

Scope (minimal, closed):

- Tier constants + `sortText` refactor (JOIN targets + ON predicates per `01-ranking-model.md` §1).
- Per-source evidence model, `JoinKnowledgeStore` (host + server), notification, `user-confirmed` command, diagnostics skeleton.
- Object identity model + pin/boost/demote/exclude store and commands. No learned bands yet; manual decisions only.
- Netezza qualification fix + cache-level same-name dedupe fix as standalone fragment **1a**:
  `getTablesAllSchemas` (`seenNames` collapse) → completion path, `DB..` constrained to default schema,
  no `DB.TABLE`, no prefix rewriting, same-named objects in two schemas stay distinct.
- No workspace scanning. No AI. No parsing on the completion path.

Dependencies: none (first stage). Normative rules: `01-ranking-model.md` (this stage must not invent
parallel tier/band definitions).

Out of scope (explicitly not started): workspace index, manager UI, import/export, executed/accepted
learning, AI. Commands exist but learned sources stay empty and disabled.

Acceptance:

- Existing behaviour locked with empty knowledge (labels/order unchanged except the two documented changes:
  manual > FK, correct cross-schema qualification).
- Configured suppresses observed (`suppressedBy: manual`); observed never outranks FK at max breadth/freshness;
  confirmation is the only promotion path and is reversible.
- Boost never crosses match rank/scope/kind; only pin does; pin changes `sortText` only.
- Fragment 1a passes with personalization disabled (proves the defect is in the source layer, not ordering).
- Canonicalization tests green: both JOIN directions, composite pairs, AND-order permutation, `DB..TABLE`.

Blocking gate to Stage 2:

- Tests 1–11, 30, 33–36, 38, 40–41, 44–45, 47 green; `sqlParser` suite + MSSQL/Oracle < 2000 ms budgets intact.
- Doc-compliance check: implementation diffed against `01-ranking-model.md` (tiers, boundaries, exclude scope).
- Manual review records the two intentional behaviour changes; no other reorder allowed.

## Implementation record

Code (single source for tiers/bands/identity): `packages/sql-core/src/joinKnowledge/`
(`model.ts`, `identity.ts`, `store.ts`, `fingerprint.ts`, `types.ts`).

Delivered in Stage 1:

- **Tier constants and sortText** — current ranking uses `0_0_` manual, `0_1_` confirmed,
  `0_2_` FK, `0_3_` favorite, `0_4_` executed, `0_5_` workspace/half-weight accepted,
  `2_` heuristic.
  ON predicates use the same order plus `0_6_` cached key and `0_7_` name match.
  Scores are bounded two-digit suffixes inside one tier.
- **Per-source evidence model** — `JoinRelationEvidenceRecord` / `ObjectEvidenceRecord`
  plus `JoinKnowledgeStore`; Stage 1 writes manual relation overrides and object
  preferences only. Workspace indexing and executed learning were added later; accepted selections
  are now counted as half-weight workspace evidence rather than a favorite.
- **Host + server store** — `JoinKnowledgeService` persists workspace-scoped
  `overrides.json` / `object-overrides.json` (append-only, `revertedAt` /
  `replacedBy`) and publishes an identifier-only `JoinKnowledgeSnapshot` through
  `netezza/joinKnowledgeChanged`. Completion reads only in-memory maps.
- **Commands (argument API, no UI yet)** —
  `netezza.confirmJoinKnowledgeRelation`, `netezza.blockJoinKnowledgeRelation`,
  `netezza.revertJoinKnowledgeOverride`, `netezza.pinSqlObject`,
  `netezza.boostSqlObject`, `netezza.demoteSqlObject`, `netezza.excludeSqlObject`,
  `netezza.revertSqlObjectPreference`, `netezza.showJoinKnowledgeStatus`.
  Stage 3 adds the manager/round-trip surface.
- **Object identity** — database + schema + name, normalized per dialect; same-named
  objects in different schemas stay distinct. Pin crosses scope/kind (sortText only),
  boost/demote stay inside match rank/scope/kind, exclude removes only FROM sources.
- **Fragment 1a** — `getTablesAllSchemas` keeps schema in its collapse key
  (no `seenNames` name-only loss); Netezza `DB..` list completion resolves the
  database `DEFSCHEMA` and never offers an object whose unqualified acceptance
  would rewrite the intended schema. `DB.TABLE` is never generated for Netezza;
  qualified target paths keep `DB..TABLE` or `DB.SCHEMA.TABLE`. Acceptance replaces
  only the typed table fragment, so the `DB..`/`DB.SCHEMA.` prefix is not rewritten.
- **Fingerprint normalization** — comments → literal placeholders → whitespace →
  case-fold is implemented and test-locked. Salted SHA-256 hashing and persistence
  stay in the host for Stage 2.
- **Settings** — `justybase.sql.personalizeFromObjects` gates FROM object
  preferences only (default `true`; empty knowledge keeps existing order).
  JOIN ranking and both intentional behavior changes are unaffected when disabled.

### Two intentional Stage 1 behaviour changes

1. **Manual/configured JOIN relations now outrank catalog FK** (`0_0_` vs `0_2_`);
   FK predicates move from the previous `0_0_` bucket to `0_2_`, cached key matches
   to `0_6_`, name matches to `0_7_`. No other relative reorder is permitted.
2. **Correct cross-schema qualification** — `DB..` completion is constrained to the
   database default schema, same-named objects in different schemas are no longer
   collapsed, and Netezza qualification never produces `DB.TABLE`.

Empty knowledge preserves the previous labels/order except change 1; object sortText
keeps the legacy `3_<scope><kind>[_<rank>]_NAME` form until a manual preference exists.

## Gate 1 record (2026-10-25)

Status: **passed**. Evidence:

- Ranking/qualification suites green: `completionEngine`, `joinKnowledgeRanking`,
  `joinKnowledge` (tiers/identity/store/fingerprint), `completionRenderer`
  (object preferences), `knowledge/*` (service + persistence), `metadataCache`,
  `completionJoinRelationUtils`, `tableQualificationResolver`.
- Full root Jest suite green (`656` suites / `11266` tests) and `sqlParser`
  suite green (`57` suites / `2146` tests), both `--runInBand --no-cache`.
- MSSQL and Oracle cold parser construction remain under the `2000 ms` budget.
- `npm run check:architecture`, `npm run lint`, `npm run docs:check`,
  `npm run version:check`, and `npm run build` pass.
- Doc-compliance checklist against `01-ranking-model.md`:
  - manual `0_0_` > confirmed `0_1_` > FK `0_2_` > observed `0_3_`–`0_5_` >
    heuristics; `suppressedBy` is emitted by the resolver and tested;
  - execution success is not treated as correctness — no execution source is
    wired in Stage 1 and the executed tier requires two distinct executions or days;
  - boost/learned/demote bands stay after match rank/scope/kind; only pin (`2_`) crosses;
  - FROM-only scope: preferences are applied only when `ranking.role === "source"`;
    JOIN and INSERT/UPDATE/DELETE/ALTER paths are untouched;
  - canonicalization orients the whole table+column pair (both directions,
    composite pairs, AND permutation, quoted identifiers, `DB..`/`DB.SCHEMA.`);
  - fingerprint normalization order is comments → `?` literals → whitespace →
    case-fold. Quoted identifiers keep byte content (step 4); the step-2
    "`?` literals" summary is interpreted as strings/numerics/date-times only,
    otherwise quoted alias rename would false-dedupe, contradicting §4's
    "alias rename ⇒ 2 fingerprints".
- Manual review recorded exactly the two intentional behavior changes above;
  no other reorder was introduced.

## Closing review (Stage 1.1, 2026-10-25)

Scope stayed inside Stage 1; no Stage 2 indexing, learning or manager UI was added.

1. **Block suppresses configured relations deliberately.**
   `a9eeab7` applies block before tiering for every source, including
   `justybase.sql.joinRelations`. `netezza.showJoinKnowledgeStatus` now states
   that a block overrides a matching configured entry, and the completion
   regression covers the full cycle: configured → blocked → reverted → configured
   restored (target and predicate, manual tier `0_0_`). Reverting is the supported
   escape hatch; the manager surface will show the same warning in Stage 3.

2. **Effective scope is captured before persistence.**
   `JoinKnowledgeService` previously computed the identity with
   `effectiveDatabase`/`effectiveSchema` only for validation, then wrote the raw
   unqualified ref. The store now accepts `defaults` for relation and object
   records, so `display` contains the scope used for the key. Round-trip tests
   cover `DB..TABLE` + default schema, a fully unqualified relation, a tampered
   key whose display lost the scope, and an unqualified object preference.

3. **Fingerprint tokenizer hardened at the edges.**
   Normalization is now single-pass. This fixes doubled delimiters in quoted
   identifiers (`"a""b"`, `[a]]b]`, `` `a``b` ``), preserves unterminated quoted
   identifiers deterministically, and adds radix (`0x…`, `0b…`) and PostgreSQL
   dollar-quoted literals. Tests lock comment markers inside literals/identifiers,
   quotes inside comments, every Netezza typed-literal prefix, unterminated
   strings/comments, and the existing alias-rename distinction. Backslash escaping
   is intentionally not guessed; standard SQL doubled-delimiter escaping is used.

4. **Cross-schema qualification is fixture- and live-tested.**
   `src/__tests__/fixtures/netezzaCrossSchemaMetadata.ts` captures the catalog
   shape for the same table name in two schemas. Unit tests use it through the real
   `MetadataCache` and the completion engine: `DB..` offers only `DEFSCHEMA`, and
   `DB.SCHEMA.` offers the other schema; acceptance inserts only the object name.
   The opt-in live test
   (`netezzaCrossSchemaCompletion.live.integration.test.ts`, requires
   `NZ_DEV_ALLOW_FIXTURE_DDL=1`) creates a dedicated schema plus two same-named
   tables, verifies the catalog rows, executes `DB..` and `DB.SCHEMA.` against the
   intended labels, drives both completion paths and their acceptance text, and
   drops the tables/schema in `afterAll`. It passed 5/5 against the development
   Netezza instance, and the fixture schema was confirmed absent afterwards.

5. **Workspace isolation and command validation.**
   The storage-root helper is tested with two workspace roots, global fallback and
   a host without storage URIs; file persistence is tested with two directories.
   A command matrix rejects missing tables/columns, empty identifiers, self
   relations, missing object names, invalid boost bands and missing override ids
   before any save or state change. Unknown override ids return `false` without a
   write.

Post-review verification (2026-10-25): full root Jest **657 suites / 11285 tests**
green; `sqlParser` **57 suites / 2146 tests** green; MSSQL/Oracle cold parser
budgets remain below **2000 ms**; `check-types`, `lint`, `lint:extended`,
`check:architecture`, `docs:check`, `version:check` and `build` pass. The live
cross-schema fixture passed **5/5** against the development Netezza instance and
left no fixture schema behind.
