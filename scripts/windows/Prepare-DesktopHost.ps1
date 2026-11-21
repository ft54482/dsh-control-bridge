# Prepares local secrets and a profile snippet. It does not quit Desktop, set a
# machine environment variable, or install the plugin.
param(
  [string]$Package = "dsh-control-bridge-host-0.1.3.tgz"
)
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$here = Join-Path $root "desktop-host-local"
New-Item -ItemType Directory -Force -Path $here | Out-Null
function New-SecretFile([string]$Name) {
  $path = Join-Path $here $Name
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $text = ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLower()
  [System.IO.File]::WriteAllText($path, $text)
  return $path
}
$hostSecret = New-SecretFile "host.secret"
$bootstrapSecret = New-SecretFile "bootstrap.secret"
$expires = [DateTimeOffset]::UtcNow.AddMinutes(20).ToUnixTimeMilliseconds()
$bootstrap = @{ secret = (Get-Content -Raw $bootstrapSecret).Trim(); expiresAt = $expires; consumed = $false }
[System.IO.File]::WriteAllText((Join-Path $here "bootstrap.json"), ($bootstrap | ConvertTo-Json -Compress))
$allow = Join-Path $here "allowlist.json"
if (-not (Test-Path $allow)) { [System.IO.File]::WriteAllText($allow, "{`"version`":1,`"workspaceAllowlist`":[],`"sessionAllowlist`":[]}") }
$snippet = @"
- id: dsh-control-bridge-host
  config:
    bind: 127.0.0.1
    port: 8765
    secretFile: $($hostSecret.Replace('\','/'))
    bootstrapFile: $((Join-Path $here 'bootstrap.json').Replace('\','/'))
    bootstrapSecretFile: $($bootstrapSecret.Replace('\','/'))
    allowlistFile: $($allow.Replace('\','/'))
    busyPolicy: refuse
    workspaceAllowlist: []
    sessionAllowlist: []
"@
[System.IO.File]::WriteAllText((Join-Path $here "cordis-snippet.yml"), $snippet)
Write-Output "Secrets stay in $here. They were not written to the machine environment."
Write-Output "Package: $Package"
Write-Output "Desktop has no supported external quit. Closing the window only hides it in the tray."
Write-Output "1. If a task is still running, let it finish. Tray Quit asks before it stops work. Do not force-kill the process."
Write-Output "2. After the tray Quit, run: dsh plugin --profile desktop add $Package"
Write-Output "3. Back up profiles\desktop\cordis.patch.yml, then replace the dsh-control-bridge-host row with cordis-snippet.yml."
Write-Output "4. Open Desktop again. Then run Pair-DesktopHost.ps1 with no index to see titles, and again with -Index."
exit 0
