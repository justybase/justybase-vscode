# SQL Snippets Reference

JustyBase includes **58 SQL code snippets** for rapid SQL development with Netezza.

## How to Use

1. Open any `.sql` file
2. Type a snippet prefix (e.g., `nzselect`)
3. Press `Tab` or accept from IntelliSense dropdown
4. Use `Tab` to jump between placeholders, `Shift+Tab` to go back

> **Tip**: All snippets start with `nz` prefix for easy discovery.

---

## Available Snippets

### Basic SQL Operations

| Prefix | Description |
|--------|-------------|
| `nzselect` | SELECT with columns and WHERE clause |
| `nzselectall` | SELECT * with LIMIT |
| `nzselecttop` | SELECT TOP with wildcard |
| `nznextvalue` | NEXT VALUE FOR sequence |
| `nzinsert` | INSERT INTO statement |
| `nzinsertmulti` | INSERT multiple rows |
| `nzupdate` | UPDATE with SET and WHERE |
| `nzdelete` | DELETE with WHERE clause |
| `nzmerge` | MERGE statement template |

### DDL Operations

| Prefix | Description |
|--------|-------------|
| `nzcreatetable` | CREATE TABLE with distribution |
| `nzcreatetableas` | CREATE TABLE AS SELECT (CTAS) |
| `nzcreateview` | CREATE VIEW template |
| `nzaltertableadd` | ALTER TABLE ADD COLUMN |
| `nzaltertabledrop` | ALTER TABLE DROP COLUMN |
| `nzdroptable` | DROP TABLE IF EXISTS |
| `nzdropview` | DROP VIEW IF EXISTS |
| `nzcreatesynonym` | CREATE SYNONYM |
| `nzdropsynonym` | DROP SYNONYM |
| `nzcreateglobaltemptable` | CREATE GLOBAL TEMPORARY TABLE |
| `nztruncate` | TRUNCATE TABLE |

### Netezza-Specific Operations

| Prefix | Description |
|--------|-------------|
| `nzgroom` | GROOM TABLE VERSIONS |
| `nzgroomall` | GROOM TABLE RECORDS ALL |
| `nzstats` | GENERATE STATISTICS for table |
| `nzstatscols` | GENERATE STATISTICS for columns |
| `nzexternaltable` | CREATE EXTERNAL TABLE |
| `nzdistribute` | DISTRIBUTE ON clause |
| `nzdistributehash` | DISTRIBUTE ON HASH |
| `nzdistributerandom` | DISTRIBUTE ON RANDOM |
| `nzorganize` | ORGANIZE ON clause |

### NZPLSQL Procedures & Functions

| Prefix | Description |
|--------|-------------|
| `nzprocedure` | Complete stored procedure skeleton |
| `nzifelse` | IF/ELSIF/ELSE block |
| `nzforloop` | FOR loop with range |
| `nzwhileloop` | WHILE loop |
| `nzcursor` | Cursor declaration and loop |
| `nzexception` | Exception handling block |
| `nzraise` | RAISE NOTICE for debugging |
| `nzraiseexception` | RAISE EXCEPTION |
| `nzvar` | Variable declaration |
| `nzexecute` | Execute dynamic SQL |

### Query Patterns

| Prefix | Description |
|--------|-------------|
| `nzjoin` | INNER JOIN template |
| `nzleftjoin` | LEFT JOIN template |
| `nzgroupby` | GROUP BY with aggregates |
| `nzcte` | Common Table Expression (WITH) |
| `nzctesmulti` | Multiple CTEs |
| `nzcase` | CASE WHEN expression |
| `nzcasesimple` | Simple CASE expression |
| `nzunion` | UNION ALL query |
| `nzexists` | EXISTS subquery |
| `nznotexists` | NOT EXISTS subquery |

### Window Functions

| Prefix | Description |
|--------|-------------|
| `nzrownumber` | ROW_NUMBER() OVER |
| `nzrank` | RANK() OVER |

### Utility Functions

| Prefix | Description |
|--------|-------------|
| `nzcoalesce` | COALESCE function |
| `nznvl` | NVL function |
| `nzcast` | CAST expression |
| `nzdate` | Common date functions |
| `nzstring` | Common string functions |
| `nzgrantselect` | GRANT SELECT |
| `nzgrantall` | GRANT ALL |

---

## Custom User Snippets via VS Code

You can create your own SQL snippets in VS Code:

1. Open Command Palette (`Ctrl+Shift+P`)
2. Select **"Preferences: Configure User Snippets"**
3. Choose **"sql.json"**
4. Add your custom snippets in the same JSON format

Example:
```json
{
  "My Custom Query": {
    "prefix": "myquery",
    "body": [
      "SELECT * FROM my_schema.my_table",
      "WHERE date_column >= CURRENT_DATE - ${1:7};"
    ],
    "description": "My frequently used query"
  }
}
```

## Custom Snippets via Favorites (Extension-Specific)

The extension provides a built-in snippet manager through the **Favorites** system, which supports variables, folder organization, and Git sync.

### Saving a Snippet

1. Open any `.sql` file
2. Right-click in the editor → **JustyBase** → **Save SQL to Favorites**
3. Enter a name and optional note
4. The snippet appears in the Schema Browser under **Favorites** → **SQL Snippets**

### Parameterized Snippets

Snippets support variable placeholders that prompt for values on open:

- `${varName}` — prompts for value
- `$varName` — prompts (legacy syntax)
- `{varName}` — prompts (alternative syntax)

**Example snippet saved as favorite:**
```sql
SELECT * FROM ${schema}.${table}
WHERE ${column} = ${value}
LIMIT 1000;
```

When you open this snippet, the extension prompts: `schema`, `table`, `column`, `value` — then inserts the resolved SQL.

### Organizing Snippets

- **Folders**: Right-click **Favorites** → **New Folder** to group snippets
- **Notes**: Right-click a snippet → **Edit Note** to add usage notes
- **Drag & Drop**: Move snippets between folders

### Git Sync

Favorites are automatically synced to `.vscode/netezza-favorites.json` in your workspace, making them shareable via Git. Commit this file to share snippets with your team.

### Copilot Integration

- **Auto-Include**: Mark a snippet to always include in `@sql-copilot` context
- **Include Next**: Include a snippet once in the next Copilot request
- **Disable**: Exclude a snippet from Copilot context entirely

Right-click on any favorite snippet in the Schema Browser → toggle Copilot options.
