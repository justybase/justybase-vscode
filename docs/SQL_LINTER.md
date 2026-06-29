# SQL Linter

JustyBase includes a built-in SQL linter that provides real-time feedback on common SQL anti-patterns and potential issues specific to Netezza.

Bulk quick-fix policy and `Fix all` eligibility are documented in [QUICK_FIX_MATRIX.md](QUICK_FIX_MATRIX.md).

## Configuration

Enable/disable the linter and customize rule severity in VS Code settings:

```json
{
  "netezza.linter.enabled": true,
  "netezza.linter.mode": "advanced",
  "netezza.linter.rules": {
    "NZ001": "warning",
    "NZ002": "error",
    "NZ007": "off"
  }
}
```

**Mode:**
- `advanced` (default): parser-based SQL/NZPLSQL validation diagnostics.

**Severity levels:** `error`, `warning`, `information`, `hint`, `off`

## Available Rules

| Rule | Default | Description |
|------|---------|-------------|
| **NZ001** | Warning | `SELECT *` usage - recommend explicit column names |
| **NZ002** | Error | `DELETE` without `WHERE` clause |
| **NZ003** | Error | `UPDATE` without `WHERE` clause |
| **NZ004** | Warning | `CROSS JOIN` detected - Cartesian product warning |
| **NZ005** | Hint | Leading wildcard `LIKE '%...'` prevents index usage |
| **NZ006** | Info | `ORDER BY` without `LIMIT` on large result sets |
| **NZ007** | Information | Inconsistent keyword casing (mixed UPPER/lower) |
| **NZ008** | Warning | `TRUNCATE` statement - data loss warning |
| **NZ009** | Hint | Multiple `OR` conditions - consider `UNION` |
| **NZ010** | Info | Missing table alias in `JOIN` |
| **NZ011** | Warning | `CREATE TABLE AS SELECT` missing `DISTRIBUTE ON` |
| **NZ012** | Error | `UPDATE table AS alias` - AS keyword not allowed in Netezza UPDATE |
| **NZ013** | Info | `UNION` instead of `UNION ALL` - performance consideration |

Parser-owned structural diagnostics supersede their legacy NZ rule IDs in active linting:

| Legacy Rule | Parser Code | Description |
|-------------|-------------|-------------|
| **NZ002** | **SQL043** | `DELETE` without `WHERE` |
| **NZ003** | **SQL044** | `UPDATE` without `WHERE` |
| **NZ011** | **SQL045** | CTAS missing explicit `DISTRIBUTE ON` |
| **NZ012** | **SQL046** | Unsupported `AS` in `UPDATE ... AS alias` |
| **NZ019** | **PAR005** / **SQL041** | `CASE` without matching `END` |
| **NZ021** | **PAR002** | Consecutive commas |
| **NZ022** | **SQL042** | `WHERE` without `FROM` |

## Examples

### NZ002 - DELETE without WHERE
```sql
-- ❌ Error: Will delete all rows
DELETE FROM customers;

-- ✅ OK: Has WHERE clause
DELETE FROM customers WHERE status = 'inactive';
```

### NZ005 - Leading Wildcard LIKE
```sql
-- ⚠️ Hint: Cannot use index
SELECT * FROM products WHERE name LIKE '%widget';

-- ✅ Better: Index can be used
SELECT * FROM products WHERE name LIKE 'widget%';
```

### NZ007 - Inconsistent Casing
```sql
-- ⚠️ Warning: Mixed case keywords
SELECT col1 from table1 WHERE id = 1;

-- ✅ Consistent: All uppercase
SELECT col1 FROM table1 WHERE id = 1;
```

### NZ011 - CTAS Missing Distribution
```sql
-- ⚠️ Warning: Missing distribution
CREATE TABLE copy_t AS SELECT * FROM original;

-- ✅ OK: Explicit distribution
CREATE TABLE copy_t AS SELECT * FROM original DISTRIBUTE ON RANDOM;
```

### NZ012 - UPDATE with AS Alias
```sql
-- ❌ Error: AS keyword not allowed in Netezza UPDATE
UPDATE customers AS c SET c.status = 'inactive';

-- ✅ OK: Alias without AS
UPDATE customers c SET c.status = 'inactive';
```

### NZ013 - UNION vs UNION ALL
```sql
-- ⚠️ Info: UNION performs implicit DISTINCT (slower)
SELECT id FROM table1 UNION SELECT id FROM table2;

-- ✅ Better: Use UNION ALL if duplicates don't matter
SELECT id FROM table1 UNION ALL SELECT id FROM table2;
```

## Smart Detection

The linter correctly ignores patterns inside:
- String literals (`'SELECT * FROM ...'`)
- Line comments (`-- SELECT * is bad`)
- Block comments (`/* DELETE FROM table */`)

---

## Advanced Mode Diagnostics (Parser-Based)

When `netezza.linter.mode` is set to `"advanced"` (default), the linter uses a full SQL parser to provide semantic validation. The following diagnostic codes are available:

### Error Codes

| Code | Severity | Description | Example |
|------|----------|-------------|---------|
| **SQL003** | Error | Unknown relation (table/CTE not found) | `SELECT * FROM nonexistent_table` |
| **SQL004** | Error | Unknown column (column not found in scope) | `SELECT fake_column FROM employees` |
| **SQL006** | Error | No relation found for qualified name | `SELECT t.column FROM employees e` (t not in scope) |
| **SQL007** | Error | Invalid DB.TABLE format (use DB..TABLE) | `SELECT * FROM mydb.mytable` (should be `mydb..mytable`) |
| **SQL008** | Error | Ambiguous column reference | `SELECT department_id FROM employees JOIN departments USING(id)` |
| **SQL010** | Error | Non-boolean expression in WHERE/ON/HAVING | `WHERE 1 + 2` (should be comparison) |
| **SQL011** | Error | Unknown function | `SELECT nonexistent_func()` |
| **SQL012** | Warning | VARCHAR without length | `CREATE TABLE t (name VARCHAR)` (should specify length) |
| **SQL013** | Error | Unknown data type | `CREATE TABLE t (col fakedtype)` |
| **SQL014** | Error | Invalid type parameters | `CREATE TABLE t (id INT(10))` (INT doesn't take params) |
| **SQL016** | Error | Unknown external table option | `CREATE EXTERNAL TABLE ... USING (UNKNOWN_OPTION 'value')` |
| **SQL017** | Error | Invalid external table option value | `CREATE EXTERNAL TABLE ... USING (MAXERRORS 'not_a_number')` |
| **SQL018** | Warning | Unused CTE definition | `WITH cte AS (...) SELECT 1` |
| **SQL019** | Warning | Unused table alias | `SELECT * FROM my_table t` (without `t.` usage) |
| **SQL020** | Error | Subquery in FROM/JOIN requires alias | `SELECT * FROM (SELECT 1)` |

### Syntax Error Codes

| Code | Severity | Description |
|------|----------|-------------|
| **LEX001** | Error | Lexer error (invalid token, unclosed string) |
| **PAR001** | Error | Parser error (syntax error, unexpected token) |

### Quick Fixes

Some diagnostic codes include automatic Quick Fixes:

| Code | Quick Fix Action |
|------|-----------------|
| **SQL007** | Convert `DB.TABLE` to `DB..TABLE` (Netezza syntax) |
| **SQL008** | Qualify ambiguous column with table alias (e.g. `a.id`) |
| **SQL012** | Add default VARCHAR length `(100)` |
| **NZ007** | Normalize inconsistent SQL keyword casing |
| **NZ010** | Add missing table alias in `FROM`/`JOIN` |
| **NZ011** | Add `DISTRIBUTE ON RANDOM` to CTAS |
| **NZ012** | Remove unsupported `AS` keyword from `UPDATE ... AS alias` |
| **NZP012** | Normalize `ELSEIF` / `ELSE IF` to `ELSIF` |

Guided **parameterized template** quick fixes are also available for high-impact unsafe diagnostics
(`NZ002`, `NZ003`, `NZ004`, `NZ011`, `NZ015`, `NZ020`, `NZP001`, `NZP002`, `NZP003`,
`NZP011`, `NZP013`, `NZP024`, `NZP027`, `NZP028`) so you can apply scaffolded rewrites with placeholders and preview.

Procedure linting uses a conservative automatic profile. Parser/CST diagnostics and high-confidence
procedure contract checks run automatically; style and heuristic NZP rules such as missing exception
handler, naming conventions, transaction-control advice, missing `EXECUTE AS`, and VARRAY advice are
available only in on-demand linting.

### Parser-Based Symbol Rename

The advanced parser model also powers SQL **Rename Symbol** (`F2`) for local SQL symbols:

- **CTE names** (`WITH cte_name AS (...)`) — definition and in-scope references
- **Table aliases** (`FROM table_name t`) — alias declaration and qualifier references (`t.column`)
- **Tables created in script** (`CREATE TABLE ...` / `CREATE TEMP TABLE ...`) — definition plus references across the whole SQL document

Rename for CTE and aliases is scoped to the current SQL statement fragment, while created tables are renamed across the document.

### Parser-Based Navigation and Autocomplete

Parser mode also powers:

- **Go to Definition** (`F12`)
- **Find References** (`Shift+F12`)
- **SQL autocomplete** for local symbols (CTE/temp table columns, aliases) and metadata-qualified paths (`DB.`, `DB..`, `DB.SCHEMA.`)
- Target-aware DDL/DML completion:
  - `DROP VIEW` suggests **only views** (view icon),
  - `DROP PROCEDURE` suggests cached procedure signatures,
  - `UPDATE` / `DROP TABLE` / `TRUNCATE TABLE` suggest table targets.
- **Scope-aware semantic autocomplete** in expression contexts (`SELECT/WHERE/ON/...`) with valid in-scope columns and SQL function suggestions

### Parser Flow Analysis API

For parser-driven script analysis and refactoring assistants, `sqlParser` now exposes `analyzeSqlScriptFlow(sql)` which returns:

- lineage edges for parser-known created tables across statements (e.g. `CREATE TEMP TABLE` → later `SELECT` / `DROP`),
- unused symbol candidates (CTE/alias),
- inline-CTE refactor candidates for single-use CTEs.

Navigation and autocomplete are parser-based.

### Examples

#### SQL003 - Unknown Relation
```sql
-- Error: Table 'nonexistent_table' does not exist
SELECT * FROM nonexistent_table;

-- OK: Table exists in schema
SELECT * FROM employees;
```

#### SQL004 - Unknown Column
```sql
-- Error: Column 'fake_column' not found in 'employees'
SELECT fake_column FROM employees;

-- OK: Column exists
SELECT first_name FROM employees;
```

#### SQL007 - Invalid DB.TABLE Format
```sql
-- Error: Netezza uses DB..TABLE (double dot) for schema-default
SELECT * FROM mydb.mytable;

-- OK: Correct Netezza syntax
SELECT * FROM mydb..mytable;

-- OK: Fully qualified
SELECT * FROM mydb.myschema.mytable;
```

#### SQL008 - Ambiguous Column
```sql
-- Error: 'department_id' exists in both tables
SELECT department_id 
FROM employees e 
JOIN departments d ON e.department_id = d.department_id;

-- OK: Qualify the column
SELECT e.department_id 
FROM employees e 
JOIN departments d ON e.department_id = d.department_id;
```

#### SQL012 - VARCHAR Without Length
```sql
-- Warning: VARCHAR should specify length
CREATE TABLE t (name VARCHAR);

-- OK: Explicit length
CREATE TABLE t (name VARCHAR(100));
```

### NZPLSQL Validation

The parser also validates stored procedures (NZPLSQL):

- Variable type validation (`INT4`, `VARCHAR(n)`, `NUMERIC(p,s)`, etc.)
- Unknown function detection in procedure body
- Invalid data type detection in `DECLARE` section
- Control flow validation (IF/END IF, LOOP/END LOOP, etc.)
