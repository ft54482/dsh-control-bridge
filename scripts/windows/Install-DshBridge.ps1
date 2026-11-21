# Installs the bridge for local use. It does not start dsh and does not touch a desktop session.
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $python = @("py", "-3") }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $python = @("python") }
else { Write-Error "Python 3.11 or newer is required."; exit 1 }
& $python[0] @($python[1..($python.Length-1)] + @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"))
if ($LASTEXITCODE -ne 0) { Write-Error "Python 3.11 or newer is required."; exit 1 }
$root = Join-Path $env:LOCALAPPDATA "dsh-control-bridge"
New-Item -ItemType Directory -Force -Path $root | Out-Null
$venv = Join-Path $root "venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  & $python[0] @($python[1..($python.Length-1)] + @("-m", "venv", $venv))
}
& (Join-Path $venv "Scripts\python.exe") -m pip install $repo
$config = Join-Path $root "bridge.toml"
if (-not (Test-Path $config)) {
  Copy-Item (Join-Path $repo "examples\config.example.toml") $config
}
& (Join-Path $venv "Scripts\dsh-bridge.exe") --config $config self-check
& (Join-Path $venv "Scripts\dsh-bridge.exe") --config $config diagnose
Write-Output "self-check finished. Headless spawn stays off until you edit your private config. This script does not launch dsh."
