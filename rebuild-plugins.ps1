<#
.SYNOPSIS
  Rebuild and reinstall every @t4r71 plugin into the running profile.

.DESCRIPTION
  The GUI loads T4 plugins from the profile node_modules, not from this source
  repo, so a source edit does nothing until this runs. Each package is built,
  its version is bumped, a NEW tarball is packed, and that tarball is installed.

  The version bump is not cosmetic: pnpm caches file: tarballs by version, so
  reinstalling the SAME version silently keeps the stale copy already in the
  store - the build would appear to do nothing.

  The host loads plugin code once, at startup, so RESTART the harness after.

.PARAMETER Package
  One or more package directory names. Defaults to every package under packages/.

.EXAMPLE
  .\rebuild-plugins.ps1
  .\rebuild-plugins.ps1 plan-tree dual-axis
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Package)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSCommandPath
$ProfileDir = 'M:\DSH-T4\home\profiles\desktop'
$Tarballs = Join-Path $ProfileDir '.tarballs'

if (-not $Package -or $Package.Count -eq 0) {
  $Package = Get-ChildItem (Join-Path $Repo 'packages') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    Select-Object -ExpandProperty Name
}

foreach ($name in $Package) {
  $dir = Join-Path $Repo "packages/$name"
  if (-not (Test-Path (Join-Path $dir 'package.json'))) {
    Write-Warning "[skip] $name - no package.json"
    continue
  }
  Write-Host "`n=== $name ===" -ForegroundColor Cyan

  # Bump the patch version so pnpm cannot serve a cached tarball.
  Push-Location $dir
  try {
    # A single-quoted here-string: in a double-quoted string PowerShell would
    # expand the `$` in the regex before node ever saw it.
    $bump = @'
const fs = require('fs')
const j = JSON.parse(fs.readFileSync('package.json', 'utf8'))
j.version = j.version.replace(/([0-9]+)$/, m => String(Number(m) + 1))
fs.writeFileSync('package.json', JSON.stringify(j, null, 2) + '\n')
console.log(j.version)
'@
    $version = (& node -e $bump | Select-Object -Last 1).Trim()
    if (-not $version) { throw "could not bump the version of $name" }
    Write-Host "  version -> $version"
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "build failed for $name" }
    $tarball = (& npm pack --pack-destination $Tarballs --silent | Select-Object -Last 1).Trim()
    Write-Host "  packed $tarball"
  } finally { Pop-Location }

  Push-Location $ProfileDir
  try {
    & pnpm add "file:.tarballs/$tarball"
    if ($LASTEXITCODE -ne 0) { throw "install failed for $name" }
  } finally { Pop-Location }
}

Write-Host "`nDone. RESTART the harness: plugin code is loaded once, at startup." -ForegroundColor Green
