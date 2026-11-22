# Reports whether Desktop must be quit before a plugin install.
# It reads command lines and does not stop any process.
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$env:PYTHONPATH = Join-Path $root "src"
$python = if ($env:DSH_BRIDGE_PYTHON) { $env:DSH_BRIDGE_PYTHON } else { "python" }
$rows = @()
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.Name -like "DeepSeek Harness*") {
    $rows += @{ image = $_.Name; command_line = $_.CommandLine }
  }
}
$payload = $rows | ConvertTo-Json -Compress
if (-not $payload) { $payload = "[]" }
$tmp = Join-Path $env:TEMP "dsh-bridge-process-scan.json"
[System.IO.File]::WriteAllText($tmp, $payload)
& $python -c "import json,sys; from pathlib import Path; from dsh_control_bridge.desktop_install import install_blocked; rows=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')); rows=rows if isinstance(rows, list) else [rows]; blocked, reason = install_blocked(rows); print(reason); raise SystemExit(2 if blocked else 0)" $tmp
exit $LASTEXITCODE
