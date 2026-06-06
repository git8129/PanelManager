param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"

$rootPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).ProviderPath).TrimEnd([char]92, [char]47)
$destPath = $Destination
$destDir = Split-Path -Parent $destPath

if (-not [string]::IsNullOrWhiteSpace($destDir)) {
  New-Item -ItemType Directory -Force $destDir | Out-Null
}
if (Test-Path -LiteralPath $destPath) {
  Remove-Item -LiteralPath $destPath -Force
}

$exclude = @(
  "PanelManager\bin\",
  "PanelManager\obj\",
  "PanelManager\Tools\",
  "FloatingWindow\bin\",
  "FloatingWindow\obj\",
  "Installer\bin\",
  "Installer\obj\",
  ".sandbox\",
  ".vs\",
  ".git\",
  "workspaces\",
  "releases\",
  "artifacts\"
)

$prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
$files = Get-ChildItem -LiteralPath $rootPath -Recurse -File | Where-Object {
  $fullName = $_.FullName
  if (-not $fullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $rel = $fullName.Substring($prefix.Length)
  $fileName = $_.Name
  if ($fileName.EndsWith(".user", [System.StringComparison]::OrdinalIgnoreCase) -or
      $fileName.EndsWith(".suo", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  foreach ($item in $exclude) {
    if ($rel.StartsWith($item, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }

  return $true
}

if (-not $files) {
  throw "No source files found for archive: $rootPath"
}

$stagingDir = Join-Path $env:TEMP ("PanelManagerSourceArchive-" + [Guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force $stagingDir | Out-Null

  foreach ($file in $files) {
    $rel = $file.FullName.Substring($prefix.Length)
    $target = Join-Path $stagingDir $rel
    $targetDir = Split-Path -Parent $target
    if (-not [string]::IsNullOrWhiteSpace($targetDir)) {
      New-Item -ItemType Directory -Force $targetDir | Out-Null
    }
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }

  Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $destPath -Force
  Write-Host "Source archive: $destPath"
}
finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
  }
}
