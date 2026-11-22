# Compares two membership fingerprints. It does not restore a backup or edit the profile.
param(
  [Parameter(Mandatory = $true)][string]$Before,
  [Parameter(Mandatory = $true)][string]$After
)
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$env:PYTHONPATH = Join-Path $root "src"
$python = $env:DSH_BRIDGE_PYTHON
if (-not $python) { $python = "python" }
& $python -m dsh_control_bridge.membership_guard --before $Before --after $After
if ($LASTEXITCODE -ne 0) {
  Write-Output "Membership changed. Stop. Do not copy an older profile backup over the current files."
}
exit $LASTEXITCODE
