using System.Text;
using UCanAccess;
using UCanAccess.File;

if (args.Length == 0 || args[0] is "-h" or "--help")
{
    PrintUsage();
    return args.Length == 0 ? 2 : 0;
}

string? source = GetOption(args, "--source");
string? ddlFile = GetOption(args, "--ddl");
string? keepTarget = GetOption(args, "--keep-target");
string? versionOption = GetOption(args, "--version");
string? repoOverride = GetOption(args, "--repo");
bool dumpRows = args.Contains("--rows");

if (source == null || (ddlFile == null && !dumpRows))
{
    Console.Error.WriteLine("--source and --ddl (or --source --rows) are required.");
    PrintUsage();
    return 2;
}
if (!File.Exists(source))
{
    Console.Error.WriteLine($"Source file not found: {source}");
    return 2;
}
if (!dumpRows && !File.Exists(ddlFile))
{
    Console.Error.WriteLine($"DDL file not found: {ddlFile}");
    return 2;
}

string repoPath = Path.GetFullPath(repoOverride
    ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".clone"));
string repoProject = Path.Combine(repoPath, "src", "UCanAccess", "UCanAccess.csproj");
if (!File.Exists(repoProject))
{
    Console.Error.WriteLine(
        $"The JustyBase.UCanAccessCs project was not found at {repoProject}. " +
        "Run bootstrap.sh first (or pass --repo <path-to-justybase-UCanAccessCs>).");
    return 2;
}

// The generated DDL is a schema-definition script, so it is replayed into a
// fresh empty Access file of the same format rather than a copy of the source.
string version = versionOption ?? (Path.GetExtension(source).Equals(".accdb", StringComparison.OrdinalIgnoreCase) ? "2016" : "2003");
string targetPath = keepTarget
    ?? Path.Combine(Path.GetTempPath(), $"jb-access-ddl-compare-{Guid.NewGuid():N}{Path.GetExtension(source)}");

try
{
    Console.WriteLine($"Source : {Path.GetFullPath(source)}");

    if (dumpRows)
    {
        return DumpRows(source) ? 0 : 1;
    }

    Console.WriteLine($"DDL    : {Path.GetFullPath(ddlFile!)}");
    Console.WriteLine($"Target : {targetPath} (version {version})");

    using (Database.Create(targetPath, version: version))
    {
        // The created database is replaced in place by the DDL statements.
    }
    ApplyDdl(targetPath, File.ReadAllText(ddlFile));

    Dictionary<string, List<string>> sourceSchema = DumpSchema(source);
    Dictionary<string, List<string>> targetSchema = DumpSchema(targetPath);

    int differences = CompareSchemas(sourceSchema, targetSchema);
    Console.WriteLine();
    Console.WriteLine($"Comparison: {(differences == 0 ? "IDENTICAL for all shared tables" : $"{differences} difference(s)")}");
    return differences == 0 ? 0 : 1;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Error: {ex.Message}");
    return 1;
}
finally
{
    if (keepTarget == null && File.Exists(targetPath))
    {
        File.Delete(targetPath);
    }
}

static void ApplyDdl(string databasePath, string ddlText)
{
    List<string> statements = SplitStatements(ddlText);
    if (statements.Count == 0)
    {
        throw new InvalidOperationException("The DDL file contains no statements.");
    }

    using var connection = UCanAccessFactory.Instance.CreateConnection()!;
    connection.ConnectionString = $"Data Source={databasePath};Read Only=false";
    connection.Open();
    try
    {
        foreach (string statement in statements)
        {
            Console.WriteLine($"Applying: {statement.Split('\n')[0]}...");
            using var command = connection.CreateCommand();
            command.CommandText = statement;
            command.ExecuteNonQuery();
        }
    }
    finally
    {
        connection.Dispose();
    }
    Console.WriteLine($"Applied {statements.Count} DDL statement(s).");
}

static List<string> SplitStatements(string ddlText)
{
    var statements = new List<string>();
    foreach (string statement in System.Text.RegularExpressions.Regex.Split(
        ddlText, @";\s*(?=CREATE\b|DROP\b|ALTER\b)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
    {
        string trimmed = statement.Trim().TrimEnd(';').Trim();
        if (trimmed.Length > 0)
        {
            statements.Add(trimmed + ";");
        }
    }
    return statements;
}

static Dictionary<string, List<string>> DumpSchema(string databasePath)
{
    using var db = Database.Open(databasePath);
    var schema = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    foreach (string name in db.GetTableNames().OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
    {
        Table? table = db.GetTable(name);
        if (table == null)
        {
            schema[name] = new List<string> { "(not readable)" };
            continue;
        }
        var lines = new List<string>();
        foreach (Column column in table.Columns.OrderBy(c => c.ColumnNumber))
        {
            lines.Add(string.Join('|',
                column.Name,
                column.Type,
                "len=" + column.ColumnLength,
                "auto=" + column.AutoNumber,
                "prec=" + column.Precision,
                "scale=" + column.Scale,
                "required=" + column.Required,
                "calc=" + column.Calculated,
                "#" + column.ColumnNumber));
        }
        foreach (IndexInfo index in db.GetIndexInfo(name).Where(i => i.PrimaryKey))
        {
            string columns = string.Join(",", index.Columns.Select(c => c.Name + (c.Ascending ? "" : " DESC")));
            lines.Add($"PK|{index.Name}|{columns}");
        }
        schema[name] = lines;
    }
    return schema;
}

static int CompareSchemas(Dictionary<string, List<string>> sourceSchema, Dictionary<string, List<string>> copySchema)
{
    int differences = 0;
    foreach (string tableName in sourceSchema.Keys.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
    {
        if (!copySchema.TryGetValue(tableName, out List<string>? copyLines))
        {
            Console.WriteLine($"MISSING in replayed copy : {tableName}");
            differences++;
            continue;
        }

        var sourceLines = sourceSchema[tableName];
        // Calculated fields cannot be recreated through Access DDL (there is no
        // DDL syntax for them), so they are expected to be absent in the replay.
        List<string> copyIdentity = copyLines.Where(line => !line.StartsWith("PK|")).ToList();
        List<string> sourceIdentity = sourceLines
            .Where(line => !line.StartsWith("PK|") && !line.Contains("calc=True"))
            .ToList();
        foreach (string calculated in sourceLines.Where(line => line.Contains("calc=True")))
        {
            Console.WriteLine($"NOTE calculated field (expected absent in replay): {tableName}: {calculated}");
        }

        if (!sourceIdentity.SequenceEqual(copyIdentity))
        {
            Console.WriteLine($"DIFF table              : {tableName}");
            foreach (string line in sourceIdentity.Except(copyIdentity, StringComparer.OrdinalIgnoreCase))
            {
                Console.WriteLine($"  source has           : {line}");
            }
            foreach (string line in copyIdentity.Except(sourceIdentity, StringComparer.OrdinalIgnoreCase))
            {
                Console.WriteLine($"  replay has           : {line}");
            }
            differences++;
        }

        string sourcePk = string.Join(";", sourceLines.Where(l => l.StartsWith("PK|")));
        string copyPk = string.Join(";", copyLines.Where(l => l.StartsWith("PK|")));
        if (!string.Equals(sourcePk, copyPk, StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine($"DIFF primary key       : {tableName}");
            Console.WriteLine($"  source               : {sourcePk}");
            Console.WriteLine($"  replay               : {copyPk}");
            differences++;
        }
    }

    foreach (string tableName in copySchema.Keys.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
    {
        if (!sourceSchema.ContainsKey(tableName))
        {
            Console.WriteLine($"EXTRA table in replay  : {tableName} (expected only for partial DDL exports)");
        }
    }
    return differences;
}

static string? GetOption(string[] args, string option)
{
    for (int i = 0; i < args.Length; i++)
    {
        if (args[i] == option)
        {
            return i + 1 < args.Length ? args[i + 1] : null;
        }
        if (args[i].StartsWith(option + "=", StringComparison.Ordinal))
        {
            return args[i][(option.Length + 1)..];
        }
    }
    return null;
}

/// <summary>
/// Dumps every non-system table's rows as JSON lines (one JSON array per
/// table) so the TypeScript writer output can be cross-checked against an
/// independent reader (the C# port of Jackcess).
/// </summary>
static bool DumpRows(string databasePath)
{
    try
    {
        using var db = Database.Open(databasePath);
        foreach (string name in db.GetTableNames().OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
        {
            Table? table = db.GetTable(name);
            if (table == null)
            {
                Console.WriteLine($"{name}\t(null table)");
                continue;
            }
            var lines = new List<string>();
            foreach (Row row in table.Rows())
            {
                var cells = new List<string>();
                for (int i = 0; i < row.Count; i++)
                {
                    cells.Add(FormatValue(row[i]));
                }
                lines.Add(string.Join("\t", cells));
            }
            Console.WriteLine($"{name}\t{lines.Count}");
            foreach (string line in lines)
            {
                Console.WriteLine(line);
            }
        }
        return true;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Error: {ex.Message}");
        return false;
    }
}

static string FormatValue(object? value)
{
    return value switch
    {
        null => "NULL",
        byte[] bytes => "BIN:" + Convert.ToHexString(bytes),
        DateTime date => "DT:" + date.ToString("yyyy-MM-dd HH:mm:ss.fff"),
        decimal d => "DEC:" + d.ToString(System.Globalization.CultureInfo.InvariantCulture),
        bool b => b ? "TRUE" : "FALSE",
        _ => value.ToString() ?? "NULL"
    };
}

static void PrintUsage()
{
    Console.WriteLine("Usage: dotnet run --project tools/access-ddl-compare -- --source <file.mdb|accdb> --ddl <generated.sql> [options]");
    Console.WriteLine("       dotnet run --project tools/access-ddl-compare -- --source <file.mdb|accdb> --rows");
    Console.WriteLine();
    Console.WriteLine("Replays the DDL generated by the VS Code extension into a fresh empty");
    Console.WriteLine("Access file using the JustyBase.UCanAccessCs port and compares the");
    Console.WriteLine("resulting table schema (type, length, autoNumber, precision, scale, PK)");
    Console.WriteLine("with the source file.");
    Console.WriteLine("  --source <path>     source .mdb/.accdb file");
    Console.WriteLine("  --ddl <path>        .sql file with the generated Access DDL");
    Console.WriteLine("  --rows              dump table rows (tabs, one table per block)");
    Console.WriteLine("  --keep-target <path> keep the replayed file at this path");
    Console.WriteLine("  --version <ver>     target file version: 2003 (default for .mdb), 2007, 2010 or 2016");
    Console.WriteLine("  --repo <path>       path to a JustyBase.UCanAccessCs checkout");
    Console.WriteLine();
    Console.WriteLine("Exit code 0: all shared tables match (or rows dumped). 1: differences found. 2: usage/setup error.");
}
