# Compile the checked-in Job Object source before owned launches start.
# The helper creates each root inside its Job. This script emits no stdout/stderr.
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
try {
    $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    $parent = [System.IO.Path]::GetDirectoryName($fullOutputPath)
    if ([string]::IsNullOrEmpty($parent)) { throw "OutputPath must include a directory." }
    [void][System.IO.Directory]::CreateDirectory($parent)
    $sourcePath = Join-Path -Path $PSScriptRoot -ChildPath "gdre-job-object.cs"
    $needsCompile = -not [System.IO.File]::Exists($fullOutputPath)
    if (-not $needsCompile) {
        $needsCompile = [System.IO.File]::GetLastWriteTimeUtc($sourcePath) -gt [System.IO.File]::GetLastWriteTimeUtc($fullOutputPath)
    }
    if ($needsCompile) {
        $source = Get-Content -LiteralPath $sourcePath -Raw
        Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $fullOutputPath
    }
    exit 0
}
catch {
    exit 1
}
