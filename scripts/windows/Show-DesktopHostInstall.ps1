# Prints the Desktop plugin install and rollback. It does not quit Desktop or run dsh.
$ErrorActionPreference = "Stop"
Write-Output "This script does not install a plugin, quit Desktop, or open a port."
Write-Output "1. Quit DeepSeek Harness from the tray. Closing the window leaves the Host running."
Write-Output "2. dsh plugin --profile desktop add dsh-control-bridge-host-0.1.3.tgz"
Write-Output "3. Set DSH_BRIDGE_HOST_SECRET to a new 32+ character value stored outside the repo."
Write-Output "4. Replace the dsh-control-bridge-host row in the desktop profile cordis.patch.yml with the authorized workspace and session only."
Write-Output "5. Reopen Desktop. Headless does not mount sessionController; do not install this bundle there and treat it as Desktop."
Write-Output "Rollback: quit Desktop, then dsh plugin --profile desktop remove dsh-control-bridge-host, delete that patch row, and reopen Desktop."
exit 0
