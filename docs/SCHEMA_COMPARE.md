# Schema Comparison

JustyBase allows you to compare table structures and procedure definitions between databases or across different environments — useful for validating schema parity before migrations or deployments.

## How to Use

Right-click on a **Table**, **View**, or **Procedure** in the Schema Browser → **Compare With...**

### Table Comparison

Compares two tables and highlights differences in:

| Aspect | Detected Differences |
|--------|---------------------|
| **Columns** | Added / removed / modified columns with type, nullability, default value changes |
| **Primary Keys** | Differences in PK columns |
| **Foreign Keys** | Added / removed / modified FK constraints |
| **Distribution** | `DISTRIBUTE ON` column changes |
| **Organization** | `ORGANIZE ON` column changes |

The comparison opens a dedicated webview panel showing a side-by-side diff with:

- **Added** items (green)
- **Removed** items (red)
- **Modified** items (yellow)
- **Unchanged** items (gray)

### Procedure Comparison

Compares two stored procedures and highlights:

- Added / removed / modified arguments
- Return type changes
- Execution ownership changes
- Source code differences

## Access

1. Ensure you have an active database connection
2. In the Schema Browser, right-click on a Table, View, or Procedure
3. Select **Compare With...**
4. Choose the target object (in the same or different database)
5. The comparison results open in a dedicated webview panel

## Supported Databases

- **Netezza** — full table and procedure comparison
- **PostgreSQL** — table and procedure/routine comparison
- **Db2** — table comparison
- **Oracle** — table comparison
- **Snowflake** — table and procedure comparison
- **DuckDB** — table comparison

> SQLite does not support schema comparison.

## Notes

- The target object can be in a different database within the same connection
- Comparison uses metadata cache when available and falls back to live queries
- Large procedures with many lines highlight the specific changed sections
