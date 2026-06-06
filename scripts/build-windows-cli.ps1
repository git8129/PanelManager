param(
  [string]$Configuration = "Debug",
  [string]$SdkVersion = "9.0.311",
  [string]$Framework = "net9.0-windows10.0.19041.0",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sandboxDir = Join-Path $root ".sandbox"
$dotnetDir = Join-Path $sandboxDir "dotnet"
$dotnetExe = Join-Path $dotnetDir "dotnet.exe"
$installer = Join-Path $sandboxDir "dotnet-install.ps1"
$nugetPackages = Join-Path $sandboxDir "nuget\packages"
$nugetConfig = Join-Path $sandboxDir "nuget\NuGet.Config"
$dotnetHome = Join-Path $sandboxDir "dotnet-home"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $sandboxDir "artifacts\build-cli"
}

New-Item -ItemType Directory -Force $sandboxDir | Out-Null
New-Item -ItemType Directory -Force $nugetPackages | Out-Null
New-Item -ItemType Directory -Force $dotnetHome | Out-Null
New-Item -ItemType Directory -Force $OutputDir | Out-Null

@"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <fallbackPackageFolders>
    <clear />
  </fallbackPackageFolders>
</configuration>
"@ | Set-Content -LiteralPath $nugetConfig -Encoding UTF8

if (-not (Test-Path $dotnetExe)) {
  Invoke-WebRequest "https://dot.net/v1/dotnet-install.ps1" -OutFile $installer
  powershell -ExecutionPolicy Bypass -File $installer -Version $SdkVersion -InstallDir $dotnetDir
}

$env:DOTNET_ROOT = $dotnetDir
$env:PATH = "$dotnetDir;$env:PATH"
$env:DOTNET_CLI_HOME = $dotnetHome
$env:NUGET_PACKAGES = $nugetPackages

$workloads = (& $dotnetExe workload list | Out-String)
if ($workloads -notmatch "maui-windows") {
  & $dotnetExe workload install maui-windows
}

$floatingWindowProject = Join-Path $root "FloatingWindow\FloatingWindow.csproj"
$panelManagerProject = Join-Path $root "PanelManager\PanelManager.csproj"

& $dotnetExe restore $floatingWindowProject --configfile $nugetConfig --packages $nugetPackages
& $dotnetExe restore $panelManagerProject --configfile $nugetConfig --packages $nugetPackages
& $dotnetExe build $panelManagerProject -c $Configuration -f $Framework -o $OutputDir --no-restore

Write-Host "Build output: $OutputDir"
