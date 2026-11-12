[CmdletBinding()]
param(
    [string]$CorpusPath = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\JustyBase.SqlConformance'),
    [string]$Output = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts/sql-conformance/typescript.json'),
    [string]$Dialect = 'netezza'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$corpusRoot = (Resolve-Path $CorpusPath).Path

$outputDirectory = Split-Path -Parent $Output
if ($outputDirectory) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

$env:JUSTYBASE_SQL_CONFORMANCE_PATH = $corpusRoot
$env:JUSTYBASE_VSCODE_PATH = $repoRoot

Write-Host '==> shared SQL conformance via the TypeScript adapter' -ForegroundColor Cyan
python (Join-Path $corpusRoot 'scripts/run_typescript.py') `
    --vscode-repo $repoRoot `
    --dialect $Dialect `
    --output $Output
if ($LASTEXITCODE -ne 0) { throw 'shared SQL conformance failed.' }
Write-Host "report: $Output" -ForegroundColor Green
