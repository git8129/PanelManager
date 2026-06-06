param(
  [string]$Configuration = "Release",
  [string]$SdkVersion = "9.0.311",
  [string]$Framework = "net9.0-windows10.0.19041.0",
  [string]$Runtime = "win-x64",
  [string]$OutputDir = "",
  [string]$GenerateSourceArchive = "true"
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
  $OutputDir = Join-Path $sandboxDir "artifacts\publish\windows-$Runtime"
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
if ($LASTEXITCODE -ne 0) {
  throw "dotnet workload list failed with exit code $LASTEXITCODE"
}
if ($workloads -notmatch "maui-windows") {
  & $dotnetExe workload install maui-windows
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet workload install maui-windows failed with exit code $LASTEXITCODE"
  }
}

$floatingWindowProject = Join-Path $root "FloatingWindow\FloatingWindow.csproj"
$panelManagerProject = Join-Path $root "PanelManager\PanelManager.csproj"

& $dotnetExe restore $floatingWindowProject --configfile $nugetConfig --packages $nugetPackages
if ($LASTEXITCODE -ne 0) {
  throw "FloatingWindow restore failed with exit code $LASTEXITCODE"
}
& $dotnetExe restore $panelManagerProject -r $Runtime --configfile $nugetConfig --packages $nugetPackages
if ($LASTEXITCODE -ne 0) {
  throw "PanelManager restore failed with exit code $LASTEXITCODE"
}
& $dotnetExe publish $panelManagerProject -c $Configuration -f $Framework -r $Runtime -o $OutputDir --no-restore -p:GenerateSourceArchive=$GenerateSourceArchive
if ($LASTEXITCODE -ne 0) {
  throw "PanelManager publish failed with exit code $LASTEXITCODE"
}

Write-Host "Publish output: $OutputDir"
