# Windows convenience wrapper for the portable installer.
param([switch]$CheckOnly, [switch]$WithLayout)
$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path -Parent $PSScriptRoot
$readerArgs = @((Join-Path $readerRoot 'scripts/setup.py'))
if ($CheckOnly) { $readerArgs += '--check-only' }
if ($WithLayout) { $readerArgs += '--with-layout' }
& python @readerArgs
if ($LASTEXITCODE -ne 0) { throw 'Setup failed; see the error above.' }
