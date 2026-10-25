# Windows PowerShell entry point for the GDRE process-tree ownership helper.
#
# Node starts this script with a private stdin pipe. The first line is a base64
# UTF-8 JSON launch request ({ executable, argv, cwd, env }) produced by the
# adapter. This script decodes and parses it with ConvertFrom-Json; it never
# evaluates it as code and never writes it to disk. The typed values are passed
# to the native helper, which creates the root with Job membership as part of
# process creation. The native helper then reads the same stream: the next byte
# or EOF is a cooperative stop request.
#
# Protocol: gdre-job-object.cs atomically replaces the supplied UTF-8 JSON file.
# See that source for the complete schema. The helper writes no diagnostics to
# stdout/stderr; root streams are forwarded through inherited handles.

param(
    [Parameter(Mandatory = $true)]
    [string]$StatusPath,
    [int]$PollMilliseconds = 100
)

$ErrorActionPreference = "Stop"
$exitCode = 2

function Write-HelperStatus {
    param(
        [string]$State,
        [string]$EventName,
        [string]$Failure,
        [bool]$CancelledBeforeLaunch
    )
    try {
        $fullStatusPath = [System.IO.Path]::GetFullPath($StatusPath)
        $statusParent = [System.IO.Path]::GetDirectoryName($fullStatusPath)
        if (-not [string]::IsNullOrEmpty($statusParent)) {
            [void][System.IO.Directory]::CreateDirectory($statusParent)
        }
        $status = [ordered]@{
            schemaVersion = 2
            state = $State
            event = $EventName
            rootPid = 0
            launch = [ordered]@{ started = $false; rootPid = 0; cancelledBeforeLaunch = $CancelledBeforeLaunch }
            attach = [ordered]@{ success = $false; rootAssigned = $false; error = $Failure }
            stop = [ordered]@{ requested = $CancelledBeforeLaunch; reason = $(if ($CancelledBeforeLaunch) { "eof" } else { $null }) }
            root = [ordered]@{ pid = 0; exitObserved = $false; exitCode = $null; observedAtUtc = $null }
            observedExitCode = $null
            cleanup = [ordered]@{ state = "not-started"; confirmed = $false; activeJobPids = $null; error = $null; jobHandleClosed = $false }
            knownPids = @()
            failure = $Failure
            updatedAtUtc = [DateTime]::UtcNow.ToString("o")
        }
        $json = $status | ConvertTo-Json -Compress -Depth 8
        [System.IO.File]::WriteAllText($fullStatusPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
    catch {
        # If the supplied status path is unusable there is no safe channel left.
    }
}

try {
    if ($env:OS -ne "Windows_NT") {
        throw "This helper is Windows-only."
    }

    if ([string]::IsNullOrWhiteSpace($StatusPath)) {
        throw "StatusPath is required."
    }

    $sourcePath = Join-Path -Path $PSScriptRoot -ChildPath "gdre-job-object.cs"
    $assemblyPath = Join-Path -Path $PSScriptRoot -ChildPath "gdre-job-object.dll"
    $useAssembly = (Test-Path -LiteralPath $assemblyPath -PathType Leaf)
    if ($useAssembly) {
        $sourceTime = [System.IO.File]::GetLastWriteTimeUtc($sourcePath)
        $assemblyTime = [System.IO.File]::GetLastWriteTimeUtc($assemblyPath)
        $useAssembly = $assemblyTime -ge $sourceTime
    }
    if ($useAssembly) {
        [void](Add-Type -Path $assemblyPath)
    }
    else {
        $source = Get-Content -LiteralPath $sourcePath -Raw
        [void](Add-Type -TypeDefinition $source -Language CSharp)
    }

    # Read exactly the launch line from the raw stream. Reading byte-by-byte
    # avoids buffering control bytes that belong to the native stop reader.
    $control = [System.IO.Stream][Console]::OpenStandardInput()
    $requestBytes = New-Object System.Collections.Generic.List[byte]
    while ($true) {
        $value = $control.ReadByte()
        if ($value -lt 0) { break }
        if ($value -eq 10) { break }
        if ($value -ne 13) { $requestBytes.Add([byte]$value) }
    }

    if ($requestBytes.Count -eq 0) {
        # EOF before a launch request means Node stopped before asking for work.
        Write-HelperStatus -State "cancelled" -EventName "cancelled-before-launch" -Failure "Cancellation was requested before the root process was created." -CancelledBeforeLaunch $true
        exit 0
    }

    $requestText = [System.Text.Encoding]::ASCII.GetString($requestBytes.ToArray())
    $requestJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($requestText))
    $request = $requestJson | ConvertFrom-Json

    $executable = [string]$request.executable
    if ([string]::IsNullOrWhiteSpace($executable)) {
        throw "The launch request has no executable."
    }
    [string[]]$arguments = @($request.argv | ForEach-Object { [string]$_ })
    $currentDirectory = [string]$request.cwd
    $environment = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($null -ne $request.env) {
        foreach ($pair in $request.env) {
            if ($null -eq $pair) { continue }
            $name = [string]$pair[0]
            if ([string]::IsNullOrEmpty($name)) { continue }
            $environment[$name] = [string]$pair[1]
        }
    }

    $exitCode = [GdreNative.GdreJobObjectRunner]::Run(
        $executable,
        $arguments,
        $currentDirectory,
        $environment,
        $StatusPath,
        $PollMilliseconds,
        $control
    )
}
catch {
    # Parameter/bind/compiler failures happen before the C# status writer exists.
    # Make one best-effort status record without emitting an error stream.
    Write-HelperStatus -State "failed" -EventName "wrapper-failed" -Failure $_.Exception.Message -CancelledBeforeLaunch $false
    $exitCode = 2
}

exit $exitCode
