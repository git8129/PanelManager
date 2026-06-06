param(
  [string]$Configuration = "Release",
  [string]$SdkVersion = "9.0.311",
  [string]$Framework = "net9.0-windows10.0.19041.0",
  [string]$Runtime = "win-x64",
  [string]$InstallerFramework = "net8.0-windows",
  [string]$OutputDir = "",
  [string]$WatermarkText = "Test Version by PD8129"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sandboxDir = Join-Path $root ".sandbox"
$dotnetDir = Join-Path $sandboxDir "dotnet"
$dotnetExe = Join-Path $dotnetDir "dotnet.exe"
$installer = Join-Path $sandboxDir "dotnet-install.ps1"
$nugetPackages = Join-Path $sandboxDir "nuget\packages"
$dotnetHome = Join-Path $sandboxDir "dotnet-home"
$sevenZipDir = Join-Path $sandboxDir "tools\7zip"
$sevenZipExe = Join-Path $sevenZipDir "7zr.exe"
$publishDir = Join-Path $sandboxDir "artifacts\publish\windows-$Runtime"
$installerWorkDir = Join-Path $sandboxDir "artifacts\installer"
$payloadZip = Join-Path $installerWorkDir "payload.7z"
$stagingDir = Join-Path $installerWorkDir "staging"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $installerWorkDir "output"
}

New-Item -ItemType Directory -Force $sandboxDir | Out-Null
New-Item -ItemType Directory -Force $nugetPackages | Out-Null
New-Item -ItemType Directory -Force $dotnetHome | Out-Null
New-Item -ItemType Directory -Force $sevenZipDir | Out-Null
New-Item -ItemType Directory -Force $installerWorkDir | Out-Null

if (-not (Test-Path $dotnetExe)) {
  Invoke-WebRequest "https://dot.net/v1/dotnet-install.ps1" -OutFile $installer
  powershell -ExecutionPolicy Bypass -File $installer -Version $SdkVersion -InstallDir $dotnetDir
}

if (-not (Test-Path -LiteralPath $sevenZipExe)) {
  Invoke-WebRequest "https://www.7-zip.org/a/7zr.exe" -OutFile $sevenZipExe
}

$env:DOTNET_ROOT = $dotnetDir
$env:PATH = "$dotnetDir;$env:PATH"
$env:DOTNET_CLI_HOME = $dotnetHome
$env:NUGET_PACKAGES = $nugetPackages

$publishScript = Join-Path $PSScriptRoot "publish-windows-cli.ps1"
$installerProject = Join-Path $root "Installer\PanelManager.Installer.csproj"

if (-not (Test-Path $publishScript)) {
  throw "Missing script: $publishScript"
}
if (-not (Test-Path $installerProject)) {
  throw "Missing project: $installerProject"
}

powershell -ExecutionPolicy Bypass -File $publishScript `
  -Configuration $Configuration `
  -SdkVersion $SdkVersion `
  -Framework $Framework `
  -Runtime $Runtime `
  -OutputDir $publishDir `
  -GenerateSourceArchive "true"

if ($LASTEXITCODE -ne 0) {
  throw "Publish failed with exit code $LASTEXITCODE"
}

if (Test-Path -LiteralPath $payloadZip) {
  Remove-Item -LiteralPath $payloadZip -Force
}
New-Item -ItemType Directory -Force $OutputDir | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $OutputDir -Force) {
  try {
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
  } catch {
    Write-Warning "Failed to remove existing output, keeping it: $($item.FullName)"
  }
}
if (Test-Path -LiteralPath $stagingDir) {
  Get-ChildItem -LiteralPath $stagingDir -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Force $stagingDir | Out-Null
}

$payloadFiles = Get-ChildItem -LiteralPath $publishDir -Force
if (-not $payloadFiles) {
  throw "Publish output is empty: $publishDir"
}

$excludePatterns = @(
  '\.pdb$'
  '\.xml$'
  '\.winmd$'
  'dotnet_bot'
  'splashSplashScreen'
  '^AboutAssets\.txt$'
  '^workloads\.'
  '^WindowsAppRuntime\.png$'
)

function Test-LanguageFolderName {
  param([string]$Name)

  # BCP-47-like publish folders: en-us, zh-CN, ca-Es-VALENCIA, quc-Latn-GT, etc.
  return $Name -match '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'
}

function Test-KeptLanguageFolderName {
  param([string]$Name)

  return $Name -match '^(en|zh)(-|$)'
}

$payloadFiles = $payloadFiles | Where-Object {
  $item = $_
  $exclude = $false

  foreach ($pattern in $excludePatterns) {
    if ($item.Name -match $pattern) {
      $exclude = $true
      break
    }
  }

  if ($item.PSIsContainer) {
    $folderName = $item.Name
    if ((Test-LanguageFolderName $folderName) -and -not (Test-KeptLanguageFolderName $folderName)) {
      $exclude = $true
    }
  }

  -not $exclude
}

$payloadCount = ($payloadFiles | Measure-Object).Count
Write-Host "Payload files count: $payloadCount"

foreach ($item in $payloadFiles) {
  Copy-Item -LiteralPath $item.FullName -Destination $stagingDir -Recurse -Force
}

if (-not [string]::IsNullOrWhiteSpace($WatermarkText)) {
  $indexPath = Join-Path $stagingDir "wwwroot\index.html"
  if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "Cannot inject watermark because index.html was not found: $indexPath"
  }

  $cssText = $WatermarkText.Replace("\", "\\").Replace('"', '\"').Replace("`r", " ").Replace("`n", " ")
  $watermarkStyle = @"
    <style id="pm-build-watermark">
        body::after {
            content: "$cssText";
            position: fixed;
            right: 28px;
            bottom: 28px;
            z-index: 2147483647;
            pointer-events: none;
            opacity: 0.24;
            color: rgba(255, 255, 255, 0.92);
            font-size: 30px;
            font-weight: 800;
            letter-spacing: 0.08em;
            text-shadow: 0 2px 12px rgba(0, 0, 0, 0.75);
        }
    </style>
"@

  $indexHtml = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
  if ($indexHtml -notmatch '<style id="pm-build-watermark">') {
    if ($indexHtml -match '</head>') {
      $indexHtml = $indexHtml -replace '</head>', ($watermarkStyle + "`r`n</head>")
    } else {
      $indexHtml = $watermarkStyle + "`r`n" + $indexHtml
    }
    [System.IO.File]::WriteAllText($indexPath, $indexHtml, [System.Text.Encoding]::UTF8)
  }
}

$stagedPayloadFiles = Get-ChildItem -LiteralPath $stagingDir -Force
if (-not $stagedPayloadFiles) {
  throw "Staging output is empty: $stagingDir"
}

& $sevenZipExe a -t7z $payloadZip (Join-Path $stagingDir "*") -mx=9 -m0=LZMA2 -mmt=on -ms=on -bd -bb0 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "7-Zip payload compression failed with exit code $LASTEXITCODE"
}

& $dotnetExe restore $installerProject
if ($LASTEXITCODE -ne 0) {
  throw "Installer restore failed with exit code $LASTEXITCODE"
}

$installerPublishDir = Join-Path ([System.IO.Path]::GetTempPath()) ("PanelManagerInstallerPublish-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $installerPublishDir | Out-Null

& $dotnetExe publish $installerProject `
  -c $Configuration `
  -f $InstallerFramework `
  -r $Runtime `
  -o $installerPublishDir `
  -p:PublishAot=true `
  -p:PayloadZip="$payloadZip" `
  -p:SevenZipExe="$sevenZipExe"

if ($LASTEXITCODE -ne 0) {
  throw "Installer publish failed with exit code $LASTEXITCODE"
}

$generatedSetupExe = Join-Path $installerPublishDir "PanelManagerSetup.exe"
if (-not (Test-Path -LiteralPath $generatedSetupExe)) {
  throw "Installer was not generated: $generatedSetupExe"
}

$setupExe = Join-Path $OutputDir "PanelManagerSetup.exe"
try {
  Copy-Item -LiteralPath $generatedSetupExe -Destination $setupExe -Force
} catch {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $setupExe = Join-Path $OutputDir "PanelManagerSetup-$stamp.exe"
  Write-Warning "Failed to write PanelManagerSetup.exe, using timestamped output instead: $setupExe"
  Copy-Item -LiteralPath $generatedSetupExe -Destination $setupExe -Force
}

try {
  Remove-Item -LiteralPath $installerPublishDir -Recurse -Force
} catch {
  Write-Warning "Failed to clean installer temp directory: $installerPublishDir"
}

Write-Host "Installer output: $setupExe"
