# Windows convenience wrapper; no working-directory or environment leakage.
param([switch]$Lan, [ValidateRange(1,65535)][int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path -Parent $PSScriptRoot
$readerPython = Join-Path $readerRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $readerPython)) { throw 'Run scripts/setup.ps1 first.' }
$readerArgs = @((Join-Path $readerRoot 'scripts/start.py'), '--port', "$Port")
if ($Lan) { $readerArgs += '--lan' }
& $readerPython @readerArgs
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 130) { throw 'Reader startup failed; see the error above.' }
