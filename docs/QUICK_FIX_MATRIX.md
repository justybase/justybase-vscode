# Quick-Fix Coverage Matrix (P53)

This document is the P53 inventory for all currently implemented `NZ*` and `NZP*` diagnostics.

## Scope and source of truth

- Rule inventory source:
  - `src/providers/linterRules.ts` (`NZ001`-`NZ020`)
  - `src/providers/procedureRules.ts` (`NZP001`-`NZP030`, excluding `NZP021`)
- Current quick-fix implementation source:
  - `src/providers/linterCodeActions.ts`

## Classification system (for P54/P55/P56)

- `SAFE`:
  - deterministic rewrite
  - preserves query/procedure intent
  - eligible for future bulk `Fix all` (P54)
- `UNSAFE`:
  - may change semantics, physical design, or requires user decisions
  - handled via guided templates (P55) or manual/Copilot review

## Impact priority scale

- `High`: correctness/data safety/security or severe performance risk
- `Medium`: meaningful performance/readability/maintainability impact
- `Low`: mostly style/convention improvements

## Current implementation snapshot

- Deterministic single-diagnostic quick fixes currently exist for:
  `NZ001`, `NZ002`, `NZ003`, `NZ004`, `NZ006`, `NZ007`, `NZ010`, `NZ011`, `NZ012`, `NZ013`, `NZP012`.
- Guided template quick fixes are implemented for the prioritized P55 set:
  `NZ002`, `NZ003`, `NZ004`, `NZ011`, `NZ015`, `NZ020`,
  `NZP001`, `NZP002`, `NZP003`, `NZP011`, `NZP013`, `NZP024`, `NZP027`, `NZP028`.
- `SAFE` classification in this document is the planning baseline for P54/P55.

---

## A) NZ* diagnostics matrix

| Code | Rule | Default Severity | Deterministic Quick Fix Today | Fixability | Impact | Recommended path | Notes |
|---|---|---|---|---|---|---|---|
| `NZ001` | Select Star | Warning | Yes | UNSAFE | High | P55 template | Expanding `*` can change result shape/contracts. |
| `NZ002` | Delete Without Where | Error | Yes | UNSAFE | High | P55 template | Guard rewrite changes DML behavior intentionally. |
| `SQL043` | Delete Without Where | Error | Yes | UNSAFE | High | P55 template | Parser-owned replacement for `NZ002`. |
| `NZ003` | Update Without Where | Error | Yes | UNSAFE | High | P55 template | Guard rewrite changes DML behavior intentionally. |
| `SQL044` | Update Without Where | Error | Yes | UNSAFE | High | P55 template | Parser-owned replacement for `NZ003`. |
| `NZ004` | Cross Join | Warning | Yes | UNSAFE | High | P55 template | Requires join predicate choice; not safe for bulk rewrite. |
| `NZ005` | Leading Wildcard Like | Hint | No | UNSAFE | Medium | P55 template | Requires predicate redesign. |
| `NZ006` | Order By Without Limit | Information | Yes | UNSAFE | Medium | P55 template | Row-limit choice depends on business intent. |
| `NZ007` | Inconsistent Keyword Case | Warning | Yes | SAFE | Low | P54 safe fix-all | Keyword casing normalization is deterministic. |
| `NZ008` | Truncate Table | Warning | No | UNSAFE | High | Manual/Copilot | Destructive operation warning; no direct auto-fix. |
| `NZ009` | Or In Where Clause | Hint | No | UNSAFE | Medium | P55 template | Rewrite strategy (`UNION`, predicate split) is contextual. |
| `NZ010` | Missing Table Alias | Information | Yes | UNSAFE | Medium | P55 template | Alias naming and downstream references require review. |
| `NZ011` | CTAS Missing Distribution | Warning | Yes | UNSAFE | High | P55 template | Distribution key is workload-specific physical design. |
| `SQL045` | CTAS Missing Distribution | Warning | Yes | UNSAFE | High | P55 template | Parser-owned replacement for `NZ011`. |
| `NZ012` | Update Alias With AS | Error | Yes | SAFE | High | P54 safe fix-all | Netezza syntax normalization (`UPDATE t a` form). |
| `SQL046` | Update Alias With AS | Error | Yes | SAFE | High | P54 safe fix-all | Parser-owned replacement for `NZ012`. |
| `NZ013` | Prefer Union All | Information | Yes | UNSAFE | Medium | P55 template | Duplicate semantics may change. |
| `NZ014` | Or In Join Condition | Error | No | UNSAFE | High | Manual/Copilot | Join-logic rewrite requires domain intent. |
| `NZ015` | Function in Where Clause | Warning | No | UNSAFE | High | P55 template | Function-to-range rewrite requires column semantics. |
| `NZ016` | Implicit Casting in Join | Warning | No | UNSAFE | High | Manual/Copilot | Requires type metadata and validated cast direction. |
| `NZ017` | Double Quoted Identifiers | Information | No | UNSAFE | Low | Manual/Copilot | Removing quotes can break case-sensitive identifiers. |
| `NZ018` | Self Referential Join | Warning | No | UNSAFE | Medium | Manual/Copilot | Could indicate bug or intentional tautology handling. |
| `NZ019` | Case Without End | Error | No | UNSAFE | High | Manual/Copilot | Structural completion cannot be inferred safely. |
| `PAR005` / `SQL041` | Case Without End | Error | No | UNSAFE | High | Manual/Copilot | Parser-owned replacement for SQL/NZPLSQL CASE structure. |
| `SQL042` | Where Without From | Error | No | UNSAFE | High | Manual/Copilot | Parser-owned replacement for `NZ022`. |
| `NZ020` | Subquery Efficiency | Information | No | UNSAFE | Medium | P55 template | `IN` -> `EXISTS/JOIN` rewrite needs semantic validation. |

---

## B) NZP* diagnostics matrix

| Code | Rule | Default Severity | Deterministic Quick Fix Today | Fixability | Impact | Recommended path | Notes |
|---|---|---|---|---|---|---|---|
| `NZP001` | Missing Procedure Delimiters | Error | No | UNSAFE | High | P55 template | Boilerplate can be suggested, but placement must be reviewed. |
| `NZP002` | Missing Language Specification | Error | No | UNSAFE | High | P55 template | Requires selecting correct language declaration. |
| `NZP003` | Missing Return Type | Warning | No | UNSAFE | Medium | P55 template | Return contract must match procedure behavior. |
| `NZP004` | Unmatched BEGIN/END Blocks | Error | No | UNSAFE | High | Manual/Copilot | Structural repair is context-sensitive. |
| `NZP005` | Unmatched IF Statement | Error | No | UNSAFE | High | Manual/Copilot | Block intent cannot be inferred safely. |
| `NZP006` | Unmatched LOOP Statement | Error | No | UNSAFE | High | Manual/Copilot | Loop boundaries require procedural intent. |
| `NZP007` | Missing Semicolon | Warning | No | UNSAFE | Medium | P55 template | Candidate for guided insertion with preview. |
| `NZP008` | Unused Variable | Information | No | UNSAFE | Low | Manual/Copilot | Removal/rename may affect dynamic SQL paths. |
| `NZP009` | Missing Exception Handler | Information | No | UNSAFE | Medium | P55 template | Handler body must be chosen by user. |
| `NZP010` | RAISE Without Severity | Information | No | UNSAFE | Low | P55 template | Severity level requires intent choice. |
| `NZP011` | Missing INTO in SELECT | Warning | No | UNSAFE | Medium | P55 template | INTO target variables must be selected. |
| `NZP012` | Incorrect ELSIF Syntax | Error | Yes | SAFE | High | P54 safe fix-all | `ELSEIF`/`ELSE IF` -> `ELSIF` is deterministic. |
| `NZP013` | Missing THEN Keyword | Error | No | UNSAFE | High | P55 template | THEN insertion points should be previewed. |
| `NZP014` | Unconditional EXIT | Warning | No | UNSAFE | Medium | P55 template | `EXIT WHEN` condition requires user expression. |
| `NZP015` | Parameter Naming Convention | Information | No | UNSAFE | Low | P55 template | Renaming must update all references safely. |
| `NZP016` | Variable Naming Convention | Information | No | UNSAFE | Low | P55 template | Renaming requires scoped reference updates. |
| `NZP017` | Unmatched CASE Statement | Error | No | UNSAFE | High | Manual/Copilot | CASE block closure is context-dependent. |
| `NZP018` | SQL Injection Risk | Warning | No | UNSAFE | High | Manual/Copilot | Security fix requires parameterization strategy. |
| `NZP019` | Optional Parameter Without Default | Information | No | UNSAFE | Low | P55 template | Default value selection is business-specific. |
| `NZP020` | Implicit Type Conversion | Information | No | UNSAFE | Medium | P55 template | CAST target types must be validated. |
| `NZP022` | OUT Parameter Without Assignment | Warning | No | UNSAFE | High | Manual/Copilot | Requires data-flow-aware repair. |
| `NZP023` | Unclosed Cursor | Warning | No | UNSAFE | High | Manual/Copilot | Close location depends on control flow. |
| `NZP024` | Missing RETURN Statement | Error | No | UNSAFE | High | P55 template | RETURN expression requires contract-aware choice. |
| `NZP025` | Transaction Control in Procedure | Warning | No | UNSAFE | High | Manual/Copilot | Transaction strategy depends on caller contract. |
| `NZP026` | Use PERFORM for Discarded Results | Information | No | UNSAFE | Medium | P55 template | Selective conversion is feasible with user review. |
| `NZP027` | Missing EXECUTE AS Clause | Information | No | UNSAFE | Medium | P55 template | `OWNER` vs `CALLER` must be selected explicitly. |
| `NZP028` | VARRAY Assignment Without EXTEND | Warning | No | UNSAFE | Medium | P55 template | Requires insertion location and sizing review. |
| `NZP029` | Deep Exception Nesting | Information | No | UNSAFE | Low | Manual/Copilot | Refactor-level change, not a local rewrite. |
| `NZP030` | Use Named Exceptions | Information | No | UNSAFE | Low | P55 template | SQLSTATE mapping is partially deterministic; keep previewed. |

> Note: `NZP021` is not currently implemented in `procedureRules.ts`, so it is not part of the active lint inventory.
> Note: `NZP007`, `NZP009`, `NZP014`, `NZP015`, `NZP016`, `NZP018`, `NZP019`, `NZP020`, `NZP025`, `NZP026`, `NZP027`, `NZP028`, `NZP029`, and `NZP030` are on-demand procedure heuristics. They are not emitted by automatic Problems diagnostics.

---

## P54/P55 prioritization outcome

1. **P54 (safe bulk fixes) implemented set**: `NZ012`, `NZ007`, `NZP012`.
2. **P55 (guided templates) implemented high-impact set**:
   `NZ002`, `NZ003`, `NZ004`, `NZ011`, `NZ015`, `NZ020`,
   `NZP001`, `NZP002`, `NZP003`, `NZP011`, `NZP013`, `NZP024`, `NZP027`, `NZP028`.
3. **Manual/Copilot-only candidates for now**:
   structurally ambiguous/security-heavy diagnostics (`NZ014`, `NZ016`, `NZ019`, `NZP004`, `NZP005`, `NZP006`, `NZP017`, `NZP018`, `NZP022`, `NZP023`, `NZP025`, `NZP029`).
