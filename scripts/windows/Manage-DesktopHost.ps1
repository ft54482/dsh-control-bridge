<#
.SYNOPSIS
  Install, upgrade or roll back the dsh-control-bridge Desktop host plugin.

.DESCRIPTION
  The plugin lives in the Desktop profile and a replacement is picked up when
  Desktop starts, so this script never starts, stops, kills or quits Desktop.
  It refuses while a Desktop process is running and tells the operator to use
  the tray's Quit DeepSeek Harness once.

  It only touches the desktop profile. It never reads or edits SuperAgent
  profiles, host.secret, browser tokens or business workspaces. Before changing
  anything it backs up the profile manifest and patch layer, and it verifies the
  package SHA-256 and installed version afterwards.

.PARAMETER Action
  Install, Upgrade or Rollback.

.PARAMETER Package
  Path to dsh-control-bridge-host-<version>.tgz for Install/Upgrade.

.PARAMETER Sha256
  Expected SHA-256 of the package. Required for Install/Upgrade.

.PARAMETER BackupDir
  Backup directory. Created if missing; required for Rollback.

.PARAMETER PreviousPackage
  Optional older package to install during Rollback instead of removing.

.PARAMETER DshHome
  DSH home directory. Defaults to $env:USERPROFILE\.dsh.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Upgrade', 'Rollback')]
  [string]$Action,

  [string]$Package,

  [string]$Sha256,

  [string]$BackupDir,

  [string]$PreviousPackage,

  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$ProfileName = 'desktop'
$PluginName = 'dsh-control-bridge-host'
$script:changed = $false

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error $Message
  exit $Code
}

function Get-DshCommand {
  $candidates = @(
    (Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
    (Join-Path $env:APPDATA 'npm\dsh.cmd'),
    (Join-Path $env:USERPROFILE 'AppData\Roaming\npm\dsh.cmd')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if (-not $candidates) { Fail 'dsh CLI not found; install DeepSeek Harness CLI first' 4 }
  return $candidates[0]
}

function Assert-DesktopQuit {
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match 'DeepSeek' -or $_.ProcessName -match 'deepseek-harness'
  })
  if ($running.Count -gt 0) {
    Fail -Message ('Desktop is running (' + (($running | Select-Object -ExpandProperty ProcessName) -join ', ') + '). Quit DeepSeek Harness from the tray once, then rerun. This script will not kill or quit it.') -Code 3
  }
}

function Assert-Package([string]$Path) {
  if (-not $Package -or -not (Test-Path -LiteralPath $Package)) { Fail 'Package is missing; pass -Package <tgz>' 2 }
  $resolved = (Resolve-Path -LiteralPath $Package).Path
  if (-not $resolved.EndsWith('.tgz')) { Fail 'Package must be a .tgz file' 2 }
  if (-not $Sha256) { Fail 'Pass -Sha256 of the package; refusing an unverified artifact' 2 }
  $actual = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) {
    Fail ("SHA-256 mismatch: expected " + $Sha256 + ", got " + $actual) 2
  }
  return $resolved
}

function Backup-Profile([string]$Destination) {
  if (-not $Destination) { Fail 'Pass -BackupDir so the profile can be restored' 2 }
  $destinationDir = [System.IO.Path]::GetFullPath($Destination)
  New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
  $profileDir = Join-Path $DshHome ("profiles\" + $ProfileName)
  foreach ($name in @('package.json', 'cordis.patch.yml')) {
    $source = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDir $name) -Force
    }
  }
  $stateDir = Join-Path $DshHome 'state\desktop-host-local'
  foreach ($name in @('allowlist.json')) {
    $source = Join-Path $stateDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDir $name) -Force
    }
  }
  # Never copy host.secret or bootstrap secrets; only the reversible files above.
  Set-Content -LiteralPath (Join-Path $destinationDir 'BACKUP-README.txt') -Encoding UTF8 -Value @(
    'Backup of the desktop profile manifest/patch layer and the grant allowlist.',
    'No host.secret, no bootstrap secret, no browser token, no workspace content.',
    'Restore with: Manage-DesktopHost.ps1 -Action Rollback -BackupDir <this directory>'
  )
  return $destinationDir
}

function Invoke-PluginAdd([string]$PackagePath) {
  $dsh = Get-DshCommand
  & $dsh plugin --profile $ProfileName add $PackagePath
  if ($LASTEXITCODE -ne 0) { Fail ("dsh plugin add failed with exit code " + $LASTEXITCODE) 5 }
  $script:changed = $true
  $installed = Join-Path $DshHome ("profiles\" + $ProfileName + "\node_modules\" + $PluginName + "\package.json")
  if (-not (Test-Path -LiteralPath $installed)) { Fail 'Plugin manifest not found after install' 5 }
  $manifest = Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
  Write-Output ("installed: " + $manifest.name + "@" + $manifest.version)
}

function Invoke-PluginRemove {
  $dsh = Get-DshCommand
  & $dsh plugin --profile $ProfileName remove $PluginName
  if ($LASTEXITCODE -ne 0) { Fail ("dsh plugin remove failed with exit code " + $LASTEXITCODE) 5 }
  $script:changed = $true
}

switch ($Action) {
  'Install' {
    Assert-DesktopQuit
    $verified = Assert-Package $Package
    $backup = Backup-Profile $BackupDir
    Invoke-PluginAdd $verified
    Write-Output ("backup: " + $backup)
    Write-Output 'next: start Desktop and check GET /v1/health; no process was started or stopped by this script'
  }
  'Upgrade' {
    Assert-DesktopQuit
    $verified = Assert-Package $Package
    $backup = Backup-Profile $BackupDir
    Invoke-PluginAdd $verified
    Write-Output ("backup: " + $backup)
    Write-Output 'next: start Desktop and compare GET /v1/guard/membership with the saved fingerprint'
  }
  'Rollback' {
    Assert-DesktopQuit
    if (-not $BackupDir -or -not (Test-Path -LiteralPath $BackupDir)) { Fail 'Rollback needs an existing -BackupDir' 2 }
    if ($PreviousPackage) {
      $previous = (Resolve-Path -LiteralPath $PreviousPackage).Path
      Invoke-PluginAdd $previous
    } else {
      Invoke-PluginRemove
    }
    $profileDir = Join-Path $DshHome ("profiles\" + $ProfileName)
    foreach ($name in @('package.json', 'cordis.patch.yml')) {
      $saved = Join-Path $BackupDir $name
      if (Test-Path -LiteralPath $saved) {
        Copy-Item -LiteralPath $saved -Destination (Join-Path $profileDir $name) -Force
      }
    }
    $allowlistBackup = Join-Path $BackupDir 'allowlist.json'
    if (Test-Path -LiteralPath $allowlistBackup) {
      $allowlistTarget = Join-Path $DshHome 'state\desktop-host-local\allowlist.json'
      Copy-Item -LiteralPath $allowlistBackup -Destination $allowlistTarget -Force
    }
    Write-Output 'rollback files restored; start Desktop and check GET /v1/health'
  }
}

if (-not $script:changed -and $Action -ne 'Rollback') { Fail 'nothing was changed' 1 }
exit 0
