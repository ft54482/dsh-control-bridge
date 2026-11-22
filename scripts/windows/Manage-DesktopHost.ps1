<#
.SYNOPSIS
  Install, upgrade or roll back the Desktop host plugin.

.DESCRIPTION
  Uses the official CLI for the desktop profile while Desktop is fully quit.
  Keeps a verified copy of the previous plugin before an upgrade and checks the
  installed version after each operation. The backup also holds the local tgz
  referenced by the profile, so retain it outside the source checkout.
  The script does not copy or restore grants, secrets, or workspace state.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Upgrade', 'Rollback')]
  [string]$Action,

  [string]$Package,
  [string]$Sha256,

  [Parameter(Mandatory = $true)]
  [string]$BackupDir,

  [string]$DshExe,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$ProfileName = 'desktop'
$PluginName = 'dsh-control-bridge-host'
$homePath = [IO.Path]::GetFullPath($DshHome)
$profilePath = Join-Path $homePath ('profiles\' + $ProfileName)
$installedPath = Join-Path $profilePath ('node_modules\' + $PluginName)
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$backupPath = [IO.Path]::GetFullPath($BackupDir)
$receiptPath = Join-Path $backupPath 'backup.json'
$previousPath = Join-Path $backupPath 'previous-host.tgz'

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error $Message -ErrorAction Continue
  exit $Code
}

function Get-DshCommand {
  if ($DshExe) {
    if (-not (Test-Path -LiteralPath $DshExe -PathType Leaf)) { Fail 'Specified -DshExe was not found.' 4 }
    return (Resolve-Path -LiteralPath $DshExe).Path
  }
  $installedCli = Get-Command dsh.cmd, dsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $installedCli) { Fail 'Desktop CLI not found; pass -DshExe pointing to the CLI bundled with Desktop.' 4 }
  return $installedCli.Source
}

function Test-IsolatedSuperAgent($Process) {
  if ($Process.Name -ne 'DeepSeek Harness.exe' -or -not $Process.ExecutablePath -or -not $Process.CommandLine) {
    return $false
  }
  $line = $Process.CommandLine.Trim()
  $exe = '"' + $Process.ExecutablePath + '"'
  if (-not $line.StartsWith($exe + ' ', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $arguments = $line.Substring($exe.Length).Trim()
  # Support the official CLI entry script as well as an executable launched directly.
  $entry = '(?:"[^"\r\n]+[\\/]@deepseek-ai[\\/](?:dsh[\\/]lib[\\/]bin|dsh-desktop-host[\\/]lib[\\/]cli)\.js"|[^\s"\r\n]+[\\/]@deepseek-ai[\\/](?:dsh[\\/]lib[\\/]bin|dsh-desktop-host[\\/]lib[\\/]cli)\.js)'
  return $arguments -match ('^(?:' + $entry + '\s+)?--profile(?:\s+|=)superagent\s+--no-open$')
}

function Assert-DesktopQuit {
  try {
    $running = @(Get-CimInstance Win32_Process -Filter "Name LIKE '%DeepSeek%'" | Where-Object { -not (Test-IsolatedSuperAgent $_) })
  } catch {
    Fail 'Could not verify that Desktop is stopped. Quit DeepSeek Harness from the tray and check process visibility.' 3
  }
  if ($running.Count -gt 0) {
    Fail -Message 'Desktop is running or a Harness process could not be classified. Quit DeepSeek Harness from the tray once, then rerun.' -Code 3
  }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PatchHash {
  if (Test-Path -LiteralPath $patchPath -PathType Leaf) { return (Get-Sha256 $patchPath) }
  return $null
}

function Assert-Manifest($Manifest) {
  if ($Manifest.name -ne $PluginName -or $Manifest.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$') {
    Fail 'Expected a versioned dsh-control-bridge-host package.' 2
  }
}

function Read-Package([string]$Path, [string]$ExpectedHash) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or $Path -notmatch '\.tgz$') {
    Fail 'A local .tgz package is required.' 2
  }
  if ($ExpectedHash -notmatch '^[0-9a-f]{64}$' -or (Get-Sha256 $Path) -ne $ExpectedHash) {
    Fail 'Package SHA-256 does not match the expected hash.' 2
  }
  $manifestJson = & tar.exe -xOf $Path 'package/package.json'
  if ($LASTEXITCODE -ne 0) { Fail 'Could not read package/package.json from the verified tgz.' 2 }
  try {
    $manifest = ($manifestJson -join "`n") | ConvertFrom-Json
  } catch {
    Fail 'The verified tgz has an invalid package manifest.' 2
  }
  Assert-Manifest $manifest
  return $manifest
}

function Read-Installed {
  $manifestPath = Join-Path $installedPath 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-Manifest $manifest
  return $manifest
}

function Backup-Installed($Manifest) {
  # Include only declared package files. Never archive the profile or its configuration.
  $files = @('package.json') + @($Manifest.files)
  foreach ($name in $files) {
    if ($name -notmatch '^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$' -or
        -not (Test-Path -LiteralPath (Join-Path $installedPath $name) -PathType Leaf)) {
      Fail 'The installed plugin has an unexpected or missing package file. Upgrade stopped before replacing it.' 2
    }
  }
  $staging = Join-Path $backupPath 'package'
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    foreach ($name in $files) {
      Copy-Item -LiteralPath (Join-Path $installedPath $name) -Destination $staging
    }
    & tar.exe -czf $previousPath -C $backupPath package
    if ($LASTEXITCODE -ne 0) { Fail 'Could not create a rollback package.' 2 }
    $hash = Get-Sha256 $previousPath
    $saved = Read-Package $previousPath $hash
    if ($saved.version -ne $Manifest.version) { Fail 'Rollback package version does not match the installed plugin.' 2 }
    return $hash
  } finally {
    foreach ($name in $files) {
      $file = Join-Path $staging $name
      if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file }
    }
    Remove-Item -LiteralPath $staging
  }
}

function Invoke-Plugin([string]$Operation, [string]$Argument, [string]$ExpectedVersion, [string]$PatchHash) {
  $dsh = Get-DshCommand
  Assert-DesktopQuit
  $originalHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $homePath
    & $dsh plugin --profile $ProfileName $Operation $Argument
    if ($LASTEXITCODE -ne 0) { Fail ("Official CLI failed with exit code " + $LASTEXITCODE + ". Keep the backup directory.") 5 }
  } finally {
    $env:DSH_HOME = $originalHome
  }
  $observed = Read-Installed
  $observedVersion = if ($observed) { $observed.version } else { '' }
  if ($observedVersion -ne $ExpectedVersion) {
    Fail 'Installed plugin version does not match the expected version. Keep the backup directory.' 5
  }
  if ([string](Get-PatchHash) -ne $PatchHash) {
    Fail 'Desktop patch changed during the operation. Inspect the local patch before restarting Desktop.' 5
  }
  if ($observed) { Write-Output ("installed: " + $PluginName + '@' + $observed.version) }
  else { Write-Output ("removed: " + $PluginName) }
}

if (-not (Test-Path -LiteralPath (Join-Path $profilePath 'package.json') -PathType Leaf)) {
  Fail 'Desktop profile has not been initialized in the selected DSH home.' 2
}
Assert-DesktopQuit
$patchHash = Get-PatchHash

if ($Action -eq 'Rollback') {
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { Fail 'Rollback needs the backup.json from the operation being reverted.' 2 }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  if ($receipt.profile_path -ne $profilePath -or $receipt.plugin -ne $PluginName) {
    Fail 'Rollback backup belongs to a different profile or plugin.' 2
  }
  $current = Read-Installed
  if ($current -and $current.version -notin @($receipt.candidate_version, $receipt.previous_version)) {
    Fail 'The installed version has changed since this backup. Select its matching backup.' 2
  }
  if ($receipt.previous_version) {
    $previous = Read-Package $previousPath $receipt.previous_sha256
    if ($previous.version -ne $receipt.previous_version) { Fail 'Rollback package does not match the saved version.' 2 }
    Invoke-Plugin 'add' $previousPath $previous.version $patchHash
  } elseif ($current) {
    Invoke-Plugin 'remove' $PluginName '' $patchHash
  }
  Write-Output 'Rollback verified. Start Desktop and check GET /v1/health.'
  exit 0
}

if (-not $Package) { Fail 'A local .tgz package is required.' 2 }
$candidatePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Package)
$candidate = Read-Package $candidatePath $Sha256
$current = Read-Installed
if ($Action -eq 'Upgrade' -and -not $current) { Fail 'Upgrade requires an installed bridge. Use Install for a fresh profile.' 2 }
if ($Action -eq 'Install' -and $current) { Fail 'The bridge is already installed. Use Upgrade to save the previous plugin.' 2 }
if ((Test-Path -LiteralPath $backupPath) -and
    (-not (Test-Path -LiteralPath $backupPath -PathType Container) -or @(Get-ChildItem -LiteralPath $backupPath -Force).Count -gt 0)) {
  Fail 'Use a new or empty backup directory.' 2
}
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
$previousHash = if ($current) { Backup-Installed $current }
$previousVersion = if ($current) { $current.version }
$stagedCandidate = Join-Path $backupPath 'candidate-host.tgz'
Copy-Item -LiteralPath $candidatePath -Destination $stagedCandidate
if ((Get-Sha256 $stagedCandidate) -ne $Sha256) { Fail 'Copied candidate failed SHA-256 verification.' 2 }
[ordered]@{
  plugin = $PluginName
  profile_path = $profilePath
  previous_version = $previousVersion
  previous_sha256 = $previousHash
  candidate_version = $candidate.version
  candidate_sha256 = $Sha256.ToLowerInvariant()
} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8

Invoke-Plugin 'add' $stagedCandidate $candidate.version $patchHash
Write-Output ("backup and retained packages: " + $backupPath)
Write-Output 'Start Desktop and compare GET /v1/guard/membership with the saved fingerprint.'
