#requires -Version 7
<#
.SYNOPSIS
    COM harness for Microsoft Access / DAO validation used by the Access
    engine tests (ACCESS_COM_VALIDATE=1). Talks to the locally installed
    Microsoft Access / Access Database Engine (ACE) through COM.

.DESCRIPTION
    Subcommands (all emit a single JSON document on stdout, errors on stderr
    with exit code 2):

      describe <file>                     TableDefs + columns + indexes + relations
                                          (with raw MSysRelationships grbit rows),
                                          table/column Description properties,
                                          linked-table markers. Read-only.
      create-db <path> <format>           Create a fresh empty database.
                                          format: mdb2000 | mdb2003 | accdb2007
                                          | accdb2010 | accdb2016
      apply-ddl <file> <sql>              Execute one DDL statement via CurrentDb.
      insert <file> <sql>                 Execute an INSERT; reports @@IDENTITY.
      select <file> <sql>                 Run a SELECT; rows as JSON (dates ISO).
      set-description <file> <table> <text>
                                          Set TableDef "Description" property.
      add-relation <file> <name> <table> <foreignTable>
                    <field> <foreignField> <attrs>
                                          Append a DAO Relation; attrs is a
                                          DAO constant bitmask (decimal).
      link-table <file> <name> <sourcePath> <sourceTable>
                                          Create a linked table via TransferDatabase.

    The database is always closed and COM released before the script exits
    (try/finally), so the .laccdb/.ldb lock is released promptly.

.EXAMPLE
    pwsh scripts/access-com/access-com.ps1 describe C:\tmp\sample.accdb
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Command,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$remainingArgs = @($RemainingArgs | Where-Object { $null -ne $_ -and $_ -ne '' })

function Write-Result {
    param($Object)
    $Object | ConvertTo-Json -Depth 12 -Compress
}

function Release-ComObject {
    param($Object)
    if ($null -eq $Object) { return }
    try {
        if ([System.Runtime.InteropServices.Marshal]::IsComObject($Object)) {
            while ([System.Runtime.InteropServices.Marshal]::ReleaseComObject($Object) -gt 0) { }
        }
    } catch { }
}

function New-DaoEngine {
    $errors = @()
    foreach ($progId in @('DAO.DBEngine.160', 'DAO.DBEngine.140', 'DAO.DBEngine.120')) {
        try {
            return New-Object -ComObject $progId
        } catch {
            $errors += "${progId}: $($_.Exception.Message)"
        }
    }
    throw "No supported DAO DBEngine COM class is installed. $($errors -join '; ')"
}

function Open-Db {
    param([string]$FilePath, [bool]$ReadOnly = $true, [bool]$Exclusive = $true)
    $engine = New-DaoEngine
    try {
        # DAO.OpenDatabase has no exclusive boolean.  The old harness passed
        # dbEncrypt/dbVersion flags here, which made ordinary databases fail
        # or appear to hang.  The caller controls read-only mode and the
        # TypeScript provider owns its own lock file for writable sessions.
        $db = $engine.OpenDatabase($FilePath, 0, $ReadOnly, '')
        return [pscustomobject]@{ Engine = $engine; Database = $db }
    } catch {
        Release-ComObject $engine
        throw
    }
}

function Close-Db {
    param($Context)
    if ($null -eq $Context) { return }
    $db = $Context.Database
    $engine = $Context.Engine
    if ($null -ne $db) {
        try { $db.Close() } catch { }
        Release-ComObject $db
    }
    Release-ComObject $engine
}

function Format-Value {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.DBNull]) { return $null }
    if ($Value -is [datetime]) { return $Value.ToString('o') }
    if ($Value -is [double] -and [double]::IsNaN($Value)) { return $null }
    return $Value
}

function Get-ComProperty {
    param($Object, [string]$Name)
    try { return $Object.$Name } catch { return $null }
}

function Get-ComText {
    param($Object, [string]$Name)
    $value = Get-ComProperty $Object $Name
    if ($null -eq $value) { return $null }
    $text = [string]$value
    if ([string]::IsNullOrEmpty($text)) { return $null }
    return $text
}

function Get-AccessHeaderFormat {
    param([string]$FilePath)
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    if ($bytes.Length -lt 21) { return 'unknown' }
    $engine = [System.Text.Encoding]::ASCII.GetString($bytes, 4, 16).Trim([char]0, ' ')
    $version = [int]$bytes[20]
    if ($engine.StartsWith('Standard Jet DB')) {
        if ($version -eq 0) { return 'jet3' }
        if ($version -eq 1) { return 'jet4' }
        return 'unknown'
    }
    if ($engine.StartsWith('Standard ACE DB')) {
        switch ($version) {
            2 { return 'accdb2007' }
            3 { return 'accdb2010' }
            4 { return 'accdb2013' }
            5 { return 'accdb2016' }
            6 { return 'accdb2019' }
        }
    }
    return 'unknown'
}

function Read-ColumnType {
    param($Field)
    $typeNames = @{
        1 = 'boolean'; 2 = 'byte'; 3 = 'int'; 4 = 'long'; 5 = 'currency'; 6 = 'single';
        7 = 'double'; 8 = 'datetime'; 10 = 'text'; 11 = 'ole'; 12 = 'memo'; 15 = 'guid';
        16 = 'bigint'; 17 = 'varBinary'; 18 = 'char'; 19 = 'numeric'; 20 = 'decimal';
        21 = 'float'; 22 = 'complex'; 101 = 'attachment'; 102 = 'multivalue'
    }
    if ($typeNames.ContainsKey([int]$Field.Type)) { return $typeNames[[int]$Field.Type] }
    return "type$($Field.Type)"
}

function Get-PropertyValue {
    param($Properties, [string]$Name)
    try {
        foreach ($property in $Properties) {
            if ($property.Name -ieq $Name) { return Format-Value $property.Value }
        }
    } catch { }
    return $null
}

function Invoke-Describe {
    param([string]$FilePath)
    $context = Open-Db -FilePath $FilePath -ReadOnly $true -Exclusive $true
    $db = $context.Database
    try {
        $result = [ordered]@{
            file = $FilePath
            format = Get-AccessHeaderFormat $FilePath
            tables = @()
            relations = @()
            relationsError = $null
            msysRelationships = @()
            msysRelationshipsError = $null
            msysRelationshipsRead = $false
        }

        foreach ($td in $db.TableDefs) {
            $tableName = [string](Get-ComProperty $td 'Name')
            $isSystem = [bool]($tableName -match '^MSys|^~')
            $connect = Get-ComText $td 'Connect'
            $table = [ordered]@{
                name = $tableName
                isSystem = $isSystem
                sourceTableName = Get-ComText $td 'SourceTableName'
                connect = $connect
                isLinked = [bool](-not [string]::IsNullOrEmpty($connect))
                description = Get-PropertyValue (Get-ComProperty $td 'Properties') 'Description'
                dateCreated = Format-Value (Get-ComProperty $td 'DateCreated')
                lastUpdated = Format-Value (Get-ComProperty $td 'LastUpdated')
                columns = @()
                indexes = @()
            }
            # Access system TableDefs can expose fields that require a UI
            # security context.  Their names/flags are enough for a catalog
            # cross-check; user tables get full field/index metadata.
            if (-not $isSystem) {
                foreach ($field in $td.Fields) {
                    $table.columns += [ordered]@{
                        name = [string](Get-ComProperty $field 'Name')
                        type = Read-ColumnType $field
                        size = [int](Get-ComProperty $field 'Size')
                        attributes = [int](Get-ComProperty $field 'Attributes')
                        sourceField = Get-ComText $field 'SourceField'
                        description = Get-PropertyValue (Get-ComProperty $field 'Properties') 'Description'
                    }
                }
                foreach ($index in $td.Indexes) {
                    $indexFields = @()
                    foreach ($ifield in $index.Fields) {
                        $indexFields += [ordered]@{
                            name = [string](Get-ComProperty $ifield 'Name')
                            order = [int](Get-ComProperty $ifield 'OrdinalPosition')
                            attributes = [int](Get-ComProperty $ifield 'Attributes')
                        }
                    }
                    $table.indexes += [ordered]@{
                        name = [string](Get-ComProperty $index 'Name')
                        primary = [bool](Get-ComProperty $index 'Primary')
                        unique = [bool](Get-ComProperty $index 'Unique')
                        ignoreNulls = [bool](Get-ComProperty $index 'IgnoreNulls')
                        required = [bool](Get-ComProperty $index 'Required')
                        fields = $indexFields
                    }
                }
            }
            $result.tables += $table
        }

        try {
            foreach ($relation in $db.Relations) {
                $relationFields = @()
                foreach ($rfield in $relation.Fields) {
                    $relationFields += [ordered]@{
                        # DAO exposes the primary-side field as Name and the
                        # referencing-side field as ForeignName.  Normalize
                        # back to the provider contract (child -> parent).
                        name = [string](Get-ComProperty $rfield 'ForeignName')
                        foreignName = [string](Get-ComProperty $rfield 'Name')
                    }
                }
                $result.relations += [ordered]@{
                    name = [string](Get-ComProperty $relation 'Name')
                    table = [string](Get-ComProperty $relation 'ForeignTable')
                    foreignTable = [string](Get-ComProperty $relation 'Table')
                    attributes = [int](Get-ComProperty $relation 'Attributes')
                    fields = $relationFields
                }
            }
        } catch {
            $result.relationsError = $_.Exception.Message
        }

        if ([Environment]::GetEnvironmentVariable('ACCESS_COM_READ_MSYS') -eq '1') {
            $rs = $null
            try {
                $rs = $db.OpenRecordset('SELECT szRelationship, grbit, ccolumn, icolumn, szObject, szColumn, szReferencedObject, szReferencedColumn FROM MSysRelationships')
                $result.msysRelationshipsRead = $true
                while (-not $rs.EOF) {
                    $result.msysRelationships += [ordered]@{
                        name = [string]$rs.Fields('szRelationship').Value
                        grbit = [int]$rs.Fields('grbit').Value
                        ccolumn = [int]$rs.Fields('ccolumn').Value
                        icolumn = [int]$rs.Fields('icolumn').Value
                        object = [string]$rs.Fields('szObject').Value
                        column = [string]$rs.Fields('szColumn').Value
                        referencedObject = [string]$rs.Fields('szReferencedObject').Value
                        referencedColumn = [string]$rs.Fields('szReferencedColumn').Value
                    }
                    $rs.MoveNext()
                }
            } catch {
                $result.msysRelationshipsError = $_.Exception.Message
            } finally {
                if ($rs) { try { $rs.Close() } catch { }; Release-ComObject $rs }
            }
        }

        return $result
    } finally {
        Close-Db $context
    }
}

function Invoke-CreateDb {
    param([string]$FilePath, [string]$Format)
    if ([System.IO.File]::Exists($FilePath)) {
        throw "Refusing to overwrite an existing database: $FilePath"
    }
    $options = switch ($Format.ToLowerInvariant()) {
        'jet3' { 32 }
        'mdb1997' { 32 }
        'mdb2000' { 64 }
        'mdb2003' { 64 }
        'accdb2007' { 128 }
        'accdb2010' { 256 } # dbVersion140
        'accdb2013' { 512 } # dbVersion150
        'accdb2016' { 768 } # dbVersion160
        'accdb2019' { 768 } # Access 2019 uses the Access 2016 ACE format
        default { throw "Unsupported database format '$Format'." }
    }
    $engine = New-DaoEngine
    try {
        $db = $engine.CreateDatabase($FilePath, ';LANGID=0x0409;CP=1252;COUNTRY=0', $options)
        try { $db.Close() } finally { Release-ComObject $db }
        # DBEngine keeps the file handle until the engine itself is released.
        # Read the header only after that release so callers can immediately
        # reopen the newly-created file.
        Release-ComObject $engine
        $engine = $null
        return [ordered]@{
            file = $FilePath
            requestedFormat = $Format.ToLowerInvariant()
            actualFormat = Get-AccessHeaderFormat $FilePath
            daoOption = $options
        }
    } finally {
        Release-ComObject $engine
    }
}

function Invoke-Execute {
    param([string]$FilePath, [string]$Sql, [bool]$IsInsert = $false)
    $context = Open-Db -FilePath $FilePath -ReadOnly $false -Exclusive $false
    $db = $context.Database
    try {
        $db.Execute($Sql, 0x80)
        $identity = $null
        $recordsAffected = [int](Get-ComProperty $db 'RecordsAffected')
        if ($IsInsert) {
            $rs = $null
            try {
                $rs = $db.OpenRecordset('SELECT @@IDENTITY AS id')
                try {
                    if (-not $rs.EOF) { $identity = [long]$rs.Fields('id').Value }
                } finally {
                    if ($rs) { try { $rs.Close() } catch { }; Release-ComObject $rs }
                }
            } catch {
                $identity = "ERR:$($_.Exception.Message)"
            }
        }
        return [ordered]@{ identity = $identity; recordsAffected = $recordsAffected }
    } finally {
        Close-Db $context
    }
}

function Invoke-Select {
    param([string]$FilePath, [string]$Sql)
    $context = Open-Db -FilePath $FilePath -ReadOnly $true -Exclusive $false
    $db = $context.Database
    try {
        $rs = $db.OpenRecordset($Sql)
        try {
            $rows = @()
            $columnNames = @()
            for ($i = 0; $i -lt $rs.Fields.Count; $i++) {
                $columnNames += [string]$rs.Fields($i).Name
            }
            while (-not $rs.EOF) {
                $row = [ordered]@{}
                for ($i = 0; $i -lt $rs.Fields.Count; $i++) {
                    $row[$columnNames[$i]] = Format-Value $rs.Fields($i).Value
                }
                $rows += $row
                $rs.MoveNext()
            }
            return [ordered]@{ columns = $columnNames; rows = $rows }
        } finally {
            if ($rs) { try { $rs.Close() } catch { }; Release-ComObject $rs }
        }
    } finally {
        Close-Db $context
    }
}

function Invoke-SetDescription {
    param([string]$FilePath, [string]$TableName, [string]$Text)
    $context = Open-Db -FilePath $FilePath -ReadOnly $false -Exclusive $false
    $db = $context.Database
    try {
        $td = $db.TableDefs($TableName)
        $property = $null
        try { $property = $td.Properties('Description') } catch { }
        if ($null -eq $property) {
            $property = $td.CreateProperty('Description', 10, $Text)
            $td.Properties.Append($property)
        } else {
            $td.Properties('Description').Value = $Text
        }
        return [ordered]@{ table = $TableName; description = $Text }
    } finally {
        Close-Db $context
    }
}

function Invoke-AddRelation {
    param([string]$FilePath, [string]$Name, [string]$Table, [string]$ForeignTable,
          [string]$Field, [string]$ForeignField, [int]$Attributes)
    $context = Open-Db -FilePath $FilePath -ReadOnly $false -Exclusive $false
    $db = $context.Database
    try {
        # DAO names the primary/one side as Table and the referencing/many
        # side as ForeignTable.  The harness API intentionally exposes the
        # provider's semantic order (child table, parent table), so invert
        # both table and field names at the DAO boundary.
        $relation = $db.CreateRelation($Name, $ForeignTable, $Table, $Attributes)
        $relField = $relation.CreateField($ForeignField)
        $relField.ForeignName = $Field
        $relation.Fields.Append($relField)
        $db.Relations.Append($relation)
        return [ordered]@{ name = $Name; table = $Table; foreignTable = $ForeignTable }
    } finally {
        Close-Db $context
    }
}

function Invoke-LinkTable {
    param([string]$FilePath, [string]$Name, [string]$SourcePath, [string]$SourceTable)
    $context = Open-Db -FilePath $FilePath -ReadOnly $false -Exclusive $false
    $db = $context.Database
    try {
        $tableDef = $db.CreateTableDef($Name)
        $tableDef.Connect = ";DATABASE=$SourcePath"
        $tableDef.SourceTableName = $SourceTable
        $db.TableDefs.Append($tableDef)
        return [ordered]@{ name = $Name; source = $SourcePath; sourceTable = $SourceTable }
    } finally {
        Close-Db $context
    }
}

function Invoke-Capabilities {
    $engine = $null
    try {
        $engine = New-DaoEngine
        return [ordered]@{ dao = $true; daoVersion = [string](Get-ComProperty $engine 'Version') }
    } catch {
        return [ordered]@{ dao = $false; error = $_.Exception.Message }
    } finally {
        Release-ComObject $engine
    }
}

try {
    switch ($Command) {
        'capabilities' {
            if ($remainingArgs.Count -ne 0) { throw 'capabilities takes no arguments' }
            Write-Result (Invoke-Capabilities)
        }
        'describe' {
            if ($remainingArgs.Count -ne 1) { throw 'describe requires: <file>' }
            Write-Result (Invoke-Describe -FilePath $remainingArgs[0])
        }
        'create-db' {
            if ($remainingArgs.Count -ne 2) { throw 'create-db requires: <path> <format>' }
            Write-Result (Invoke-CreateDb -FilePath $remainingArgs[0] -Format $remainingArgs[1])
        }
        'apply-ddl' {
            if ($remainingArgs.Count -ne 2) { throw 'apply-ddl requires: <file> <sql>' }
            Write-Result (Invoke-Execute -FilePath $remainingArgs[0] -Sql $remainingArgs[1])
        }
        'insert' {
            if ($remainingArgs.Count -ne 2) { throw 'insert requires: <file> <sql>' }
            Write-Result (Invoke-Execute -FilePath $remainingArgs[0] -Sql $remainingArgs[1] -IsInsert $true)
        }
        'select' {
            if ($remainingArgs.Count -ne 2) { throw 'select requires: <file> <sql>' }
            Write-Result (Invoke-Select -FilePath $remainingArgs[0] -Sql $remainingArgs[1])
        }
        'set-description' {
            if ($remainingArgs.Count -ne 3) { throw 'set-description requires: <file> <table> <text>' }
            Write-Result (Invoke-SetDescription -FilePath $remainingArgs[0] -TableName $remainingArgs[1] -Text $remainingArgs[2])
        }
        'add-relation' {
            if ($remainingArgs.Count -ne 7) { throw 'add-relation requires: <file> <name> <table> <foreignTable> <field> <foreignField> <attrs>' }
            Write-Result (Invoke-AddRelation -FilePath $remainingArgs[0] -Name $remainingArgs[1] -Table $remainingArgs[2] -ForeignTable $remainingArgs[3] -Field $remainingArgs[4] -ForeignField $remainingArgs[5] -Attributes ([int]$remainingArgs[6]))
        }
        'link-table' {
            if ($remainingArgs.Count -ne 4) { throw 'link-table requires: <file> <name> <sourcePath> <sourceTable>' }
            Write-Result (Invoke-LinkTable -FilePath $remainingArgs[0] -Name $remainingArgs[1] -SourcePath $remainingArgs[2] -SourceTable $remainingArgs[3])
        }
        default { throw "Unknown command: $Command" }
    }
} catch {
    [Console]::Error.WriteLine("ERR: $($_.Exception.Message)")
    exit 2
}
