# Starts the local bridge listener. It does not launch the desktop app or dsh.
param([switch]$Serve, [int]$Port = 8787)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:LOCALAPPDATA "dsh-control-bridge"
$exe = Join-Path $root "venv\Scripts\dsh-bridge.exe"
$config = Join-Path $root "bridge.toml"
if (-not (Test-Path $exe)) { Write-Error "Run Install-DshBridge.ps1 first."; exit 1 }
& $exe --config $config diagnose
if ($Serve) {
  & $exe --config $config serve --host 127.0.0.1 --port $Port
}
