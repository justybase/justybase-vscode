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

The comparison flow reads Netezza catalog views (`_V_OBJECT_DATA`,
`_V_PROCEDURE`) and uses Netezza object notation, so it is currently available
for Netezza connections only. Other dialects require their own catalog-backed
target enumeration and a dialect-neutral diff model before they can be
advertised; they remain a planned capability, not a supported one.

> Table comparison for non-Netezza dialects is not implemented yet; do not rely
> on the command outside Netezza. SQLite does not support schema comparison.

## Notes

- The target object can be in a different database within the same connection
- Comparison uses metadata cache when available and falls back to live queries
- Large procedures with many lines highlight the specific changed sections
