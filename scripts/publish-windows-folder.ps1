param(
  [string]$Configuration = "Release",
  [string]$Framework = "net9.0-windows10.0.19041.0",
  [string]$Runtime = "win-x64",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "publish-windows-cli.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Missing script: $scriptPath"
}

powershell -ExecutionPolicy Bypass -File $scriptPath -Configuration $Configuration -Framework $Framework -Runtime $Runtime -OutputDir $OutputDir
