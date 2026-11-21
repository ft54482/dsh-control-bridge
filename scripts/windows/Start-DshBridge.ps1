# Local diagnose helper. It does not launch desktop or dsh and does not edit the persistent PATH.
param(
  [Parameter(Mandatory = $true)][string]$PythonExe,
  [string]$Config = "bridge.toml",
  [string]$DataDir = "data",
  [switch]$Serve,
  [int]$Port = 8787
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $PythonExe)) {
  Write-Error "PythonExe not found: $PythonExe"
  exit 1
}
if (-not (Test-Path -LiteralPath $Config)) {
  Write-Error "Config not found: $Config. Copy examples\config.example.toml yourself. This script does not create it."
  exit 1
}
$repo = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$env:PYTHONPATH = Join-Path $repo "src"
$python = (Resolve-Path -LiteralPath $PythonExe).Path
& $python -m dsh_control_bridge --config $Config --data-dir $DataDir diagnose
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Serve) {
  & $python -m dsh_control_bridge --config $Config --data-dir $DataDir serve --host 127.0.0.1 --port $Port
  exit $LASTEXITCODE
}
