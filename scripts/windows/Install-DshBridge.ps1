# Installs the bridge into a new local directory. It does not start real dsh or Desktop.
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $python = @("py", "-3") }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $python = @("python") }
else { Write-Error "Python 3.11 or newer is required."; exit 1 }
& $python[0] @($python[1..($python.Length-1)] + @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"))
if ($LASTEXITCODE -ne 0) { Write-Error "Python 3.11 or newer is required."; exit 1 }
$root = Join-Path $env:LOCALAPPDATA "dsh-control-bridge"
$work = Join-Path $root "isolated-workspace"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$venvPy = Join-Path $root "venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  & $python[0] @($python[1..($python.Length-1)] + @("-m", "venv", (Join-Path $root "venv")))
}
& $venvPy -m pip install $repo
& $venvPy -m dsh_control_bridge.windows_selfcheck
Write-Output "Stage 1 install and stage 2 fake-process self-check only. spawn stays off for a real dsh. No model call was made."
