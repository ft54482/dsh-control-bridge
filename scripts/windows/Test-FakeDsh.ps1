# Fake dsh.cmd self-check. No model call, no real dsh, no persistent PATH change.
param(
  [string]$PythonExe
)
$ErrorActionPreference = "Stop"
$repo = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$env:PYTHONPATH = Join-Path $repo "src"

function Invoke-SelectedPython {
  param([string[]]$Arguments)
  if ($PythonExe) {
    if (-not (Test-Path -LiteralPath $PythonExe)) {
      Write-Error "PythonExe not found: $PythonExe"
      exit 1
    }
    $selected = (Resolve-Path -LiteralPath $PythonExe).Path
    & $selected @Arguments
    return
  }
  Write-Warning "-PythonExe was not given, so this falls back to py -3 or python. Pass -PythonExe to pin the bundled Python 3.12. The persistent PATH is not changed."
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 @Arguments
    return
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    & python @Arguments
    return
  }
  Write-Error "Python 3.11 or newer is required. Pass -PythonExe."
  exit 1
}

Invoke-SelectedPython -Arguments @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)")
if ($LASTEXITCODE -ne 0) {
  Write-Error "Python 3.11 or newer is required."
  exit 1
}
Invoke-SelectedPython -Arguments @("-c", "import sys; print(sys.executable); print(sys.version.split()[0])")
Write-Output "persistent_PATH_not_changed=true"
Invoke-SelectedPython -Arguments @("-m", "dsh_control_bridge.windows_selfcheck")
exit $LASTEXITCODE
