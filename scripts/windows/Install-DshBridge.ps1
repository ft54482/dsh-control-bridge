# Runs the fake self-check from this unpacked directory.
# It does not download packages, edit the persistent PATH, or write outside Destination.
param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$PythonExe
)
$ErrorActionPreference = "Stop"
$repo = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$dest = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($dest -ne $repo.TrimEnd('\')) {
  Write-Error "Destination must be this unpacked directory: $repo. Refusing to copy the package or write outside it."
  exit 1
}
$hostExe = (Get-Process -Id $PID).Path
& $hostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Test-FakeDsh.ps1") -PythonExe $PythonExe
exit $LASTEXITCODE
