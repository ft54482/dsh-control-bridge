# Runs the fake dsh.cmd self-check. It does not call a model and does not start Desktop.
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $python = @("py", "-3") }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $python = @("python") }
else { Write-Error "Python 3.11 or newer is required."; exit 1 }
$env:PYTHONPATH = Join-Path $repo "src"
& $python[0] @($python[1..($python.Length-1)] + @("-m", "dsh_control_bridge.windows_selfcheck"))
exit $LASTEXITCODE
