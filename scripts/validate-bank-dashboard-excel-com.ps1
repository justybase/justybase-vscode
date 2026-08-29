<#
.SYNOPSIS
    Validate dashboard XLSX files by opening them in desktop Microsoft Excel.

.DESCRIPTION
    This is a read-only Excel COM smoke/integrity test. It disables macros,
    external-link updates, events and alerts, opens each workbook read-only,
    forces a full calculation, and checks formula errors, ListObjects,
    dashboard charts, PivotTables and slicer caches. No workbook is saved.

    Run from the repository root, preferably in an interactive Windows session:

      pwsh -File scripts/validate-bank-dashboard-excel-com.ps1
      pwsh -File scripts/validate-bank-dashboard-excel-com.ps1 -Path .\some.xlsx

    Excel COM can fail with 0x80070520 when PowerShell is launched in a
    non-interactive service session. In that case run the command from a
    normal Windows desktop session.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string[]]$Path
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $PSScriptRoot

function Release-ComObject {
    param([AllowNull()][object]$Object)

    if ($null -eq $Object) {
        return
    }

    try {
        if ([System.Runtime.InteropServices.Marshal]::IsComObject($Object)) {
            [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) | Out-Null
        }
    } catch {
        # Cleanup must not hide the original workbook validation failure.
    }
}

function Get-LongCount {
    param([AllowNull()][object]$Object)

    if ($null -eq $Object) {
        return [int64]0
    }

    try {
        return [int64]$Object.CountLarge
    } catch {
        return [int64]$Object.Count
    }
}

function Add-Problem {
    param(
        [System.Collections.Generic.List[string]]$Problems,
        [string]$Message
    )

    $Problems.Add($Message)
}

function Test-ExcelWorkbook {
    param(
        [object]$Excel,
        [string]$FilePath
    )

    $workbook = $null
    $problems = [System.Collections.Generic.List[string]]::new()
    $sheetResults = [System.Collections.Generic.List[object]]::new()
    $opened = $false
    $isExternalReference = [System.IO.Path]::GetFileName($FilePath) -in @(
        "superstore-sales-dashboard.xlsx",
        "personal-finance-dashboard-2026.xlsx"
    )

    $result = [ordered]@{
        file = [System.IO.Path]::GetFileName($FilePath)
        path = [System.IO.Path]::GetFullPath($FilePath)
        opened = $false
        readOnly = $false
        sheetCount = 0
        formulaCells = [int64]0
        formulaErrors = [int64]0
        formulaErrorAddresses = @()
        calculationState = -1
        dashboardCharts = 0
        listObjects = 0
        pivotTables = 0
        slicerCaches = 0
        sheets = @()
        problems = @()
        status = "FAIL"
    }

    try {
        # The short overload is more reliable through PowerShell's COM
        # binder than passing all optional VARIANT arguments. UpdateLinks=0
        # and ReadOnly=$true keep the source file untouched.
        $workbook = $Excel.Workbooks.Open($FilePath, 0, $true)
        $opened = $true
        $result.opened = $true
        $result.readOnly = [bool]$workbook.ReadOnly
        $result.sheetCount = [int]$workbook.Worksheets.Count

        try {
            $workbook.ForceFullCalculation = $true
        } catch {
            Add-Problem $problems "Could not enable ForceFullCalculation: $($_.Exception.Message)"
        }

        try {
            $Excel.CalculateFullRebuild()
        } catch {
            Add-Problem $problems "Full calculation failed: $($_.Exception.Message)"
        }
        $result.calculationState = [int]$Excel.CalculationState

        $calculationDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while ([int]$Excel.CalculationState -ne 0 -and [DateTime]::UtcNow -lt $calculationDeadline) {
            Start-Sleep -Milliseconds 100
        }

        for ($sheetIndex = 1; $sheetIndex -le $workbook.Worksheets.Count; $sheetIndex++) {
            $sheet = $null
            $usedRange = $null
            $formulaCells = $null
            $errorCells = $null
            $listObjects = $null
            $chartObjects = $null
            $pivotTables = $null

            try {
                $sheet = $workbook.Worksheets.Item($sheetIndex)
                $sheetProblems = [System.Collections.Generic.List[string]]::new()
                $sheetResult = [ordered]@{
                    name = [string]$sheet.Name
                    usedRange = ""
                    formulaCells = [int64]0
                    formulaErrors = [int64]0
                    formulaErrorAddresses = @()
                    listObjects = @()
                    charts = 0
                    chartSeries = 0
                    pivotTables = 0
                    problems = @()
                }

                $usedRange = $sheet.UsedRange
                $sheetResult.usedRange = [string]$usedRange.Address($false, $false)

                try {
                    $formulaCells = $usedRange.SpecialCells(-4123)
                    $formulaCount = Get-LongCount $formulaCells
                    $sheetResult.formulaCells = $formulaCount
                    $result.formulaCells += $formulaCount
                } catch {
                    # SpecialCells raises when the range has no formulas.
                }

                try {
                    $errorCells = $usedRange.SpecialCells(-4123, 16)
                    $errorCount = Get-LongCount $errorCells
                    $sheetResult.formulaErrors = $errorCount
                    $sheetResult.formulaErrorAddresses = @([string]$errorCells.Address($false, $false))
                    $result.formulaErrors += $errorCount
                    $result.formulaErrorAddresses += $sheetResult.formulaErrorAddresses
                    Add-Problem $sheetProblems "Found $errorCount formula error cell(s)"
                } catch {
                    # SpecialCells raises when there are no formula errors.
                }

                $listObjects = $sheet.ListObjects
                for ($tableIndex = 1; $tableIndex -le $listObjects.Count; $tableIndex++) {
                    $table = $null
                    $tableRange = $null
                    $dataBodyRange = $null
                    try {
                        $table = $listObjects.Item($tableIndex)
                        $tableRange = $table.Range
                        $dataBodyRange = $table.DataBodyRange
                        $dataRows = if ($null -eq $dataBodyRange) { 0 } else { [int]$dataBodyRange.Rows.Count }
                        $sheetResult.listObjects += [ordered]@{
                            name = [string]$table.Name
                            range = [string]$tableRange.Address($false, $false)
                            columns = [int]$table.ListColumns.Count
                            dataRows = $dataRows
                        }
                        $result.listObjects++
                    } catch {
                        Add-Problem $sheetProblems "ListObject inspection failed: $($_.Exception.Message)"
                    } finally {
                        Release-ComObject $dataBodyRange
                        Release-ComObject $tableRange
                        Release-ComObject $table
                    }
                }

                $chartObjects = $sheet.ChartObjects()
                $sheetResult.charts = [int]$chartObjects.Count
                if ([string]$sheet.Name -ieq "Dashboard") {
                    $result.dashboardCharts += [int]$chartObjects.Count
                }
                for ($chartIndex = 1; $chartIndex -le $chartObjects.Count; $chartIndex++) {
                    $chartObject = $null
                    $chart = $null
                    $seriesCollection = $null
                    try {
                        $chartObject = $chartObjects.Item($chartIndex)
                        $chart = $chartObject.Chart
                        $seriesCollection = $chart.SeriesCollection()
                        $seriesCount = [int]$seriesCollection.Count
                        $sheetResult.chartSeries += $seriesCount
                        if ($seriesCount -eq 0) {
                            Add-Problem $sheetProblems "Chart '$($chartObject.Name)' has no series"
                        }
                        for ($seriesIndex = 1; $seriesIndex -le $seriesCount; $seriesIndex++) {
                            $series = $null
                            try {
                                $series = $seriesCollection.Item($seriesIndex)
                                $xValues = $series.XValues
                                $values = $series.Values
                                $xValueCount = if ($xValues -is [array]) { $xValues.Length } elseif ($null -eq $xValues) { 0 } else { 1 }
                                $valueCount = if ($values -is [array]) { $values.Length } elseif ($null -eq $values) { 0 } else { 1 }
                                if (($xValueCount -eq 0 -or $valueCount -eq 0) -and -not $isExternalReference) {
                                    Add-Problem $sheetProblems "Chart '$($chartObject.Name)' has an empty category/value cache"
                                }
                            } finally {
                                Release-ComObject $series
                            }
                        }
                    } catch {
                        Add-Problem $sheetProblems "Chart inspection failed: $($_.Exception.Message)"
                    } finally {
                        Release-ComObject $seriesCollection
                        Release-ComObject $chart
                        Release-ComObject $chartObject
                    }
                }

                $pivotTables = $sheet.PivotTables()
                $sheetResult.pivotTables = [int]$pivotTables.Count
                $result.pivotTables += [int]$pivotTables.Count
                for ($pivotIndex = 1; $pivotIndex -le $pivotTables.Count; $pivotIndex++) {
                    $pivot = $null
                    try {
                        $pivot = $pivotTables.Item($pivotIndex)
                    } catch {
                        Add-Problem $sheetProblems "PivotTable inspection failed: $($_.Exception.Message)"
                    } finally {
                        Release-ComObject $pivot
                    }
                }

                $sheetResult.problems = @($sheetProblems)
                $sheetResults.Add([pscustomobject]$sheetResult)
                foreach ($sheetProblem in $sheetProblems) {
                    Add-Problem $problems "$($sheet.Name): $sheetProblem"
                }
            } catch {
                Add-Problem $problems "Worksheet inspection failed: $($_.Exception.Message)"
            } finally {
                Release-ComObject $pivotTables
                Release-ComObject $chartObjects
                Release-ComObject $listObjects
                Release-ComObject $errorCells
                Release-ComObject $formulaCells
                Release-ComObject $usedRange
                Release-ComObject $sheet
            }
        }

        try {
            $result.slicerCaches = [int]$workbook.SlicerCaches.Count
        } catch {
            # Excel versions without SlicerCaches expose this property as an error.
            $result.slicerCaches = 0
        }

        if (-not $result.readOnly) {
            Add-Problem $problems "Workbook was not opened read-only"
        }

        $dashboardSheets = @($sheetResults | Where-Object { $_.name -ieq "Dashboard" })
        if ($dashboardSheets.Count -ne 1) {
            Add-Problem $problems "Expected exactly one Dashboard worksheet, found $($dashboardSheets.Count)"
        }
        $rawSheets = @($sheetResults | Where-Object { $_.name -like "Raw_*" })
        if (-not $isExternalReference) {
            if ($rawSheets.Count -eq 0) {
                Add-Problem $problems "No Raw_* worksheet was found"
            }
            foreach ($rawSheet in $rawSheets) {
                if (@($rawSheet.listObjects).Count -ne 1) {
                    Add-Problem $problems "$($rawSheet.name): expected exactly one ListObject, found $(@($rawSheet.listObjects).Count)"
                }
            }
        }
        if ($result.dashboardCharts -eq 0) {
            Add-Problem $problems "Dashboard has no chart objects"
        }
        if ($isExternalReference) {
            if ($result.pivotTables -eq 0) {
                Add-Problem $problems "External dashboard has no PivotTables"
            }
            if ($result.slicerCaches -eq 0) {
                Add-Problem $problems "External dashboard has no slicer caches"
            }
        }
    } catch {
        Add-Problem $problems "Workbook open/validation failed: $($_.Exception.Message)"
    } finally {
        if ($workbook) {
            try { $workbook.Close($false) } catch { }
        }
        Release-ComObject $workbook
    }

    $result.sheets = @($sheetResults)
    $result.problems = @($problems)
    $result.status = if ($opened -and $problems.Count -eq 0) { "PASS" } else { "FAIL" }
    return [pscustomobject]$result
}

if (-not $Path -or $Path.Count -eq 0) {
    $Path = @(
        Get-ChildItem -LiteralPath (Join-Path $scriptRoot "fixtures\bank-dashboards") -Filter "*.xlsx" -File -Recurse |
            Sort-Object FullName |
            Select-Object -ExpandProperty FullName
    )
}

$resolvedPaths = foreach ($candidate in $Path) {
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
    if ([System.IO.Path]::GetExtension($resolved.Path).ToLowerInvariant() -ne ".xlsx") {
        throw "Only .xlsx files are supported by the Excel COM validator: $($resolved.Path)"
    }
    $resolved.Path
}

$excel = $null
$results = [System.Collections.Generic.List[object]]::new()
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.EnableEvents = $false
    $excel.AskToUpdateLinks = $false
    $excel.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
    try {
        $excel.Calculation = -4105 # xlCalculationAutomatic
    } catch {
        # Some Excel automation hosts reject changing the global mode before
        # a workbook is open. Test-ExcelWorkbook still forces a full rebuild.
    }

    foreach ($filePath in $resolvedPaths) {
        $results.Add((Test-ExcelWorkbook -Excel $excel -FilePath $filePath))
    }
} catch {
    Write-Error "Excel COM initialization failed: $($_.Exception.Message)"
    exit 2
} finally {
    if ($excel) {
        try { $excel.Quit() } catch { }
    }
    Release-ComObject $excel
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

$results | ConvertTo-Json -Depth 10
if (($results | Where-Object { $_.status -ne "PASS" }).Count -gt 0) {
    exit 1
}
