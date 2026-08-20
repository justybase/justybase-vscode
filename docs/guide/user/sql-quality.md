---
title: SQL quality and diagnostics
description: Read parser, lexer, linter, type, and NZPLSQL diagnostics and apply only the fixes you understand.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.16.37
---

# SQL quality and diagnostics

JustyBase combines syntax parsing, semantic/schema validation, quality rules, and optional database validation. The diagnostic prefix tells you which layer raised the issue:

| Prefix | Meaning | Typical action |
| --- | --- | --- |
| `LEX*` | Lexer could not classify the text | Fix an invalid character, literal, or token boundary. |
| `PAR*` | Parser could not build the expected statement structure | Read the first error and repair the clause around it. |
| `SQL*` | Parser/semantic validation, often relation, column, type, or identifier scope | Refresh metadata or correct the object/reference. |
| `NZ*` | SQL quality rule for warehouse safety, style, or performance | Review the warning in the context of workload and policy. |
| `NZP*` | NZPLSQL procedure rule | Fix block, variable, return, or procedure contract issues. |

## Rule families

- **Safety:** destructive statements without a predicate, risky `TRUNCATE`, and operations that need confirmation.
- **Correctness:** unknown relations/columns, ambiguous references, invalid object qualification, malformed aliases, and type-aware comparisons.
- **Performance:** leading wildcard `LIKE`, functions in predicates, implicit casts in joins, unnecessary `OR`, `SELECT *`, unbounded ordering, and distribution choices.
- **Style:** keyword case, aliases, quoted identifiers, and `UNION` versus `UNION ALL` choices.
- **Types:** SQL025/SQL026 warnings compare column metadata with literal classification. They require typed metadata and are not emitted as certain errors without it.
- **NZPLSQL:** procedure structure, language/returns clauses, unmatched blocks, `SELECT … INTO`, unused variables, `OUT` assignment, `ELSIF`, `THEN`, `CASE`, and `RETURN` checks.

## Severity and policy

Set a rule to `error`, `warning`, `information`, `hint`, or `off` under `justybase.linter.rules`. `justybase.linter.enabled` controls the linter surface; advanced parser-based validation remains the core syntax path. Severity changes the editor and Problems panel, not the SQL sent to the database.

## Before and after

### Destructive update

```sql
-- Before: NZ003 / safe-execute confirmation
UPDATE SALES.ORDERS SET status = 'CLOSED';

-- After: explicit scope
UPDATE SALES.ORDERS
SET status = 'CLOSED'
WHERE order_date < CURRENT_DATE - 90;
```

### Wildcard search

```sql
-- Before: NZ005 can prevent an index-friendly access path
WHERE customer_name LIKE '%smith';

-- After: choose the intent explicitly
WHERE customer_name ILIKE 'smith%';
```

### Join type mismatch

```sql
-- Before: implicit cast risk
ON fact.customer_id = dim.customer_id_text

-- After: make the conversion and data-quality decision visible
ON CAST(fact.customer_id AS VARCHAR(32)) = dim.customer_id_text
```

The correct rewrite is workload- and dialect-dependent. A quick fix is a proposal, not permission to execute.

## Quick-fix classes

| Class | Behavior |
| --- | --- |
| Automatic | The action has an exact, local edit with no database side effect. Review the diff before saving. |
| Preview required | The action changes a statement or needs DDL/import context; JustyBase shows the proposed SQL or mapping first. |
| Suggestion only | The rule cannot safely infer intent; use the diagnostic as a review prompt. |

Parser-based rename and navigation use token ranges. Regex heuristics are limited to procedure rules that run only when the CST parse cannot provide a reliable result. See the [quick-fix coverage matrix](guide/legacy/quick_fix_matrix/) for the implementation-level inventory.

## NZPLSQL boundary

The CST procedure path handles structural rules first. A string-body procedure is reparsed with offset mapping. Migrated NZP rules run through the regex fallback only when parsing fails, so a malformed procedure does not silently produce confident semantic results. Always fix the first `PAR*`/`NZP*` structural error before interpreting later warnings.

## Database-dependent diagnostics

SQL003/SQL004/SQL007-style relation and qualification checks can be useful without a connection, but column existence and SQL025/SQL026 type comparisons require metadata. The extension-host validator maps catalog `FORMAT_TYPE` into `ColumnInfo.dataType`; the LSP provider maps the metadata bridge type into the same contract. If those paths disagree, report the database kind and a minimal query.

## Copilot handoff

The safest AI loop is `diagnostic → schema/DDL context → explanation → suggested fix → diff review → user execution`. [AI SQL Assistant](guide/user/ai-assistant/) documents what is sent, what is read-only, and where a user confirmation is required.
