# Lists sessions by title or records the numbered choice. It does not quit Desktop.
param(
  [int]$Index = 0,
  [ValidateSet("read", "write")][string]$Access = "read"
)
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$secret = Join-Path $root "desktop-host-local\bootstrap.secret"
$secretText = ""
if (Test-Path $secret) { $secretText = ([System.IO.File]::ReadAllText($secret)).Trim() }
if ($secretText.Length -lt 32) {
  Write-Error "No armed pairing window. Run Rearm-DesktopHostBootstrap.ps1 (the Host does not need a restart), then run this script again."
  exit 2
}
$python = $null
if ($env:DSH_BRIDGE_PYTHON) { $python = $env:DSH_BRIDGE_PYTHON }
elseif (Get-Command py -ErrorAction SilentlyContinue) { $python = (Get-Command py).Source }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $python = (Get-Command python).Source }
else { Write-Error "Python is required to pair. Pass it with DSH_BRIDGE_PYTHON for this process only."; exit 1 }
$env:PYTHONPATH = Join-Path $root "src"
$pairArgs = @("-m", "dsh_control_bridge.pair_desktop", "--bootstrap-secret-file", $secret, "--access", $Access)
if ($Index -gt 0) { $pairArgs += @("--index", "$Index") }
& $python @pairArgs
exit $LASTEXITCODE
