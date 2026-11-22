# Re-arms the one-time desktop pairing window without quitting Desktop.
#
# It writes only bootstrap.secret and bootstrap.json under desktop-host-local.
# The long-lived host secret and allowlist.json are hashed before and after and
# are never written here; if either changes during the run, the script fails.
# The running Host re-reads the window on every request, so no restart is
# needed and no process is started or stopped.
param(
  [string]$Root = "",
  [ValidateRange(1, 60)][int]$Minutes = 20
)
$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
} else {
  $Root = [System.IO.Path]::GetFullPath($Root)
}
$here = Join-Path $Root "desktop-host-local"
$hostSecret = Join-Path $here "host.secret"
$allowlist = Join-Path $here "allowlist.json"
$bootstrapSecret = Join-Path $here "bootstrap.secret"
$bootstrapFile = Join-Path $here "bootstrap.json"

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

if (-not (Test-Path $here)) { Fail "desktop-host-local was not found under $Root. Run Prepare-DesktopHost.ps1 once first." }
if (-not (Test-Path $hostSecret)) { Fail "host.secret is missing. Refusing to create or rotate it from this script." }
if (-not (Test-Path $allowlist)) { Fail "allowlist.json is missing. Refusing to arm a window with no durable grant file." }

$hostSecretBefore = (Get-FileHash -Algorithm SHA256 -Path $hostSecret).Hash
$allowlistBefore = (Get-FileHash -Algorithm SHA256 -Path $allowlist).Hash

$hostText = ([System.IO.File]::ReadAllText($hostSecret)).Trim()
if ($hostText.Length -lt 32) { Fail "host.secret is shorter than 32 characters; repair it with Prepare-DesktopHost.ps1 first." }
try {
  $null = [System.IO.File]::ReadAllText($allowlist) | ConvertFrom-Json
} catch {
  Fail "allowlist.json is not valid JSON. Repair it before arming a pairing window."
}

# New secret for the new window only.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLower()
$expiresAt = [DateTimeOffset]::UtcNow.AddMinutes($Minutes).ToUnixTimeMilliseconds()
$bootstrap = [ordered]@{
  version = 1
  secret = $secret
  expiresAt = $expiresAt
  consumed = $false
}

# Write the legacy secret file first and the JSON last, so a reader never sees
# a new expiry paired with an old secret.
$secretTmp = "$bootstrapSecret.tmp"
$jsonTmp = "$bootstrapFile.tmp"
try {
  [System.IO.File]::WriteAllText($secretTmp, $secret)
  [System.IO.File]::WriteAllText($jsonTmp, ($bootstrap | ConvertTo-Json -Compress))
  Move-Item -Force -LiteralPath $secretTmp -Destination $bootstrapSecret
  Move-Item -Force -LiteralPath $jsonTmp -Destination $bootstrapFile
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $secretTmp, $jsonTmp
}

$hostSecretAfter = (Get-FileHash -Algorithm SHA256 -Path $hostSecret).Hash
$allowlistAfter = (Get-FileHash -Algorithm SHA256 -Path $allowlist).Hash
if ($hostSecretBefore -ne $hostSecretAfter) { Fail "host.secret changed during the run; the pairing window may be inconsistent. Do not pair until you inspect it." }
if ($allowlistBefore -ne $allowlistAfter) { Fail "allowlist.json changed during the run; the pairing window may be inconsistent. Do not pair until you inspect it." }

$expiresLocal = [DateTimeOffset]::FromUnixTimeMilliseconds($expiresAt).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz")
Write-Output "Pairing window re-armed until $expiresLocal ($Minutes minute(s))."
Write-Output "Wrote only bootstrap.secret and bootstrap.json. host.secret and allowlist.json are unchanged."
Write-Output "Desktop does not need to be quit or restarted; the running Host reads the window per request."
Write-Output "Next: Pair-DesktopHost.ps1           (list sessions)"
Write-Output "      Pair-DesktopHost.ps1 -Index N  (write one grant; the window is spent then)"
exit 0
