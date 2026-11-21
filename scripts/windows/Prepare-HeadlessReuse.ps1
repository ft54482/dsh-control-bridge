# Plans the official headless credential patch. It does not edit desktop or install plugins.
# -Apply writes only profiles\headless\cordis.patch.yml and a backup beside it.
param(
  [Parameter(Mandatory = $true)][string]$PythonExe,
  [Parameter(Mandatory = $true)][string]$DshHome,
  [switch]$Apply,
  [switch]$Rollback
)
$ErrorActionPreference = "Stop"
if ($Apply -and $Rollback) { Write-Error "Choose -Apply or -Rollback, not both."; exit 2 }
if (-not (Test-Path -LiteralPath $PythonExe)) { Write-Error "PythonExe not found: $PythonExe"; exit 1 }
$repo = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$env:PYTHONPATH = Join-Path $repo "src"
$python = (Resolve-Path -LiteralPath $PythonExe).Path
$arguments = @("-m", "dsh_control_bridge.home_prepare", "--home", $DshHome)
if ($Rollback) { $arguments += "--rollback" }
if ($Apply) { $arguments += "--apply" }
Write-Output "persistent_PATH_not_changed=true"
Write-Output "desktop_profile_not_modified=true"
Write-Output "credentials_file_not_copied=true"
Write-Output "plugin_install=not_performed"
& $python @arguments
exit $LASTEXITCODE
