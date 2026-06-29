# Query Execution & Analysis Reference

This guide covers query execution features and the powerful Explain Plan tool.

---

## Query Execution Modes

### Smart Query (`Ctrl+Enter` or `F5`)

Executes the **current statement** or **selected text**.

**Behavior:**
- If text is selected → executes selection
- If cursor in statement → executes that statement
- Statements are separated by semicolons

### Batch Query (`Ctrl+F5` or `Ctrl+Shift+Enter`)

Executes **all statements** in the file sequentially.

**Use cases:**
- Running migration scripts
- Executing multiple CREATE statements
- Running ETL scripts with multiple queries

---

## Explain Query Plan

Analyze how Netezza will execute your query **before running it**.

### How to Use

1. Select or position cursor on a query
2. Press `Ctrl+L` or click the **Graph** icon in toolbar
3. View the execution plan

### Available Modes

| Mode | Command | Shortcut | Description |
|------|---------|----------|-------------|
| Standard | Explain Query Plan | `Ctrl+L` | Basic plan with operations and costs |
| Verbose | Explain Query Plan (Verbose) | - | Detailed plan with statistics |

### Understanding the Plan

The plan shows:

| Element | Description |
|---------|-------------|
| **Operation** | Type of operation (Scan, Join, Sort, etc.) |
| **Object** | Table or index being accessed |
| **Est. Rows** | Estimated number of rows |
| **Est. Cost** | Relative cost (lower is better) |
| **Width** | Estimated row width in bytes |

### Common Operations

| Operation | Description | Optimization Tips |
|-----------|-------------|-------------------|
| **Seq Scan** | Full table scan | Consider adding WHERE clause or index |
| **SPU Scan** | Parallel scan across SPUs | Normal for Netezza |
| **Hash Join** | Join using hash table | Good for large joins |
| **Merge Join** | Join using sorted data | Efficient for sorted data |
| **Sort** | Sorting operation | Consider if ORDER BY is necessary |
| **Aggregate** | GROUP BY / COUNT / SUM | Normal for aggregations |

### Tips for Query Optimization

1. **High cost operations** - Focus on reducing these first
2. **Seq Scan on large tables** - Check if DISTRIBUTE ON matches JOIN keys
3. **Sort operations** - Only use ORDER BY when necessary
4. **Statistics** - Run `GENERATE STATISTICS` if estimates are wrong

---

## SQL Formatter

Automatically format SQL for readability.
Formatter is now built into the extension (no external formatter dependency) and preserves comments/literals while changing layout.

### How to Use

- Press `Shift+Alt+F`
- Or right-click → **Format SQL**
- Or click the **Format** icon in toolbar

### Settings

Configure in VS Code Settings (`Ctrl+,`):

| Setting | Default | Options |
|---------|---------|---------|
| `netezza.formatSQL.tabWidth` | 4 | Number of spaces for indentation |
| `netezza.formatSQL.keywordCase` | `upper` | `upper`, `lower`, `preserve` |

### Example

**Before:**
```sql
select a.id,b.name,c.value from schema.table1 a inner join schema.table2 b on a.id=b.id left join schema.table3 c on b.id=c.id where a.status='active' and b.date>current_date-30 order by a.id
```

**After (formatted):**
```sql
SELECT
    a.id,
    b.name,
    c.value
FROM
    schema.table1 a
    INNER JOIN schema.table2 b ON a.id = b.id
    LEFT JOIN schema.table3 c ON b.id = c.id
WHERE
    a.status = 'active'
    AND b.date > CURRENT_DATE - 30
ORDER BY
    a.id
```

---

## Connection Management

### Multiple Connections

Each SQL tab can use a different connection.

**How to switch connection:**
1. Click the **Database** icon in editor toolbar
2. Select connection from dropdown
3. Connection is saved per tab

### Connection State

- 🟢 **Connected** - Active connection
- 🔴 **Disconnected** - No connection / connection lost
- Status bar shows current connection

### Keep Connection Open

Toggle persistent connection to avoid reconnecting for each query:
- Command Palette → `Netezza: Toggle Keep Connection Open`

---

## Keyboard Shortcuts Summary

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` / `F5` | Run current statement |
| `Ctrl+Shift+Enter` | Run all statements |
| `Ctrl+L` | Explain Query Plan |
| `Shift+Alt+F` | Format SQL |
| `Ctrl+Shift+L` | Lint SQL (On-Demand) |

---

## Query History

Access and reuse previously executed queries:

1. Click **Query History** in Netezza sidebar.
2. Use search, tags, favorites-only mode, or saved views.
3. Click an entry to view details, edit tags/description, copy, or run.
4. Use **Extended View** for larger datasets and active+archive search.

### Quick Re-run with Parameters

Query history supports placeholder-driven rerun flow:

- `:paramName`
- `${paramName}`
- `{paramName}`
- `@paramName`
- `#{paramName}`

When placeholders are detected, the panel can request parameter values and open a ready-to-run SQL statement.

### Favorites and Workspace Sync

- Mark history rows as favorites for fast filtering.
- SQL snippets saved to **Favorites** in the schema explorer support variable prompts on open.
- Favorites are synced to workspace file: `.vscode/netezza-favorites.json`.
